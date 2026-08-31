//! 本地 Codex Responses↔Chat 转换代理。
//!
//! 背景:网关(如迈金)对 gpt-5.6 家族的 `/responses` 转换有缺陷(内部 responses→chat
//! 翻译失败,上游稳定 502/“Model resources are currently busy”),但 `/chat/completions`
//! 直连正常;而 Codex 已移除 `wire_api = "chat"`,只认 Responses 协议。
//!
//! 方案:Codex 的 base_url 指向本机代理;代理按模型规则把 Responses 请求翻译成 Chat
//! Completions 打到网关可用端点,并把响应(含 SSE 流式双向)翻译回 Responses 返回 Codex。
//! 其它模型(原生 responses 可用,如 deepseek 系)原样透传,不受影响。
//! 参考实现正确姿势:cc-switch `transform_codex_chat.rs`(工具→chat 顶层 tools,
//! 严禁塞进 messages content item)。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const DEFAULT_PORT: u16 = 17321;
/// OpenAI-compatible function name 最大长度(chat 上游校验 ^[a-zA-Z0-9_-]+$,且有长度上限)。
const CHAT_TOOL_NAME_MAX_LEN: usize = 64;
pub const DEFAULT_CONVERT_PATTERN: &str = "gpt-5.6|glm|kimi-k2.6|kimi-k3|kimi-lastest|step-3.7|MiMo|grok-4.6|claude-sonnet-5|claude-opus-5|gemini-3|deepseek-v4-flash";

static SEQ: AtomicU64 = AtomicU64::new(0);
fn next_id(prefix: &str) -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{prefix}_{ts}_{n}")
}

// ---------------------------------------------------------------------------
// 模型转换规则
// ---------------------------------------------------------------------------

/// 模型 id 是否需要走 Responses→Chat 转换(大小写不敏感子串匹配)。
pub fn should_convert(model: &str, pattern: &str) -> bool {
    let m = model.to_lowercase();
    pattern
        .split('|')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .any(|p| m.contains(&p))
}

// ---------------------------------------------------------------------------
// Responses → Chat(请求方向)
// ---------------------------------------------------------------------------

/// 把一条 responses message 的 content 数组转成 chat 的 content(字符串或 parts 数组)。
fn message_content_to_chat(content: &Value) -> Value {
    let arr = content.as_array().cloned().unwrap_or_default();
    let mut parts: Vec<Value> = Vec::new();
    for p in &arr {
        match p.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "input_text" => {
                if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                    parts.push(json!({"type": "text", "text": t}));
                }
            }
            "input_image" => {
                // 5.6 原生多模态:把 image_url 原样带过去(v1 尽力而为;失败上游会报错)。
                let mut part = json!({"type": "image_url"});
                let mut url_obj = serde_json::Map::new();
                if let Some(u) = p.get("image_url").and_then(|v| v.as_str()) {
                    url_obj.insert("url".into(), json!(u));
                } else if let Some(d) = p.get("data").and_then(|v| v.as_str()) {
                    url_obj.insert("url".into(), json!(d));
                }
                part["image_url"] = json!(url_obj);
                parts.push(part);
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        Value::String(String::new())
    } else if parts.len() == 1 && parts[0].get("type") == Some(&Value::String("text".into())) {
        parts[0]["text"].clone()
    } else {
        json!(parts)
    }
}

fn role_to_chat_role(role: &str) -> &'static str {
    match role {
        "developer" | "system" => "system",
        "user" => "user",
        "assistant" => "assistant",
        _ => "user",
    }
}

/// Responses 工具定义 → chat tools(必须映射为顶层 tools,严禁塞进 content)。
fn responses_tool_to_chat_tool(tool: &Value) -> Option<Value> {
    let t = tool.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match t {
        "function" => {
            let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                return None;
            }
            let mut f = serde_json::Map::new();
            f.insert("name".into(), json!(name));
            if let Some(d) = tool.get("description") {
                f.insert("description".into(), d.clone());
            }
            if let Some(p) = tool.get("parameters") {
                f.insert("parameters".into(), p.clone());
            }
            if let Some(s) = tool.get("strict") {
                f.insert("strict".into(), s.clone());
            }
            Some(json!({"type": "function", "function": json!(f)}))
        }
        "custom" => {
            // Codex 的 freeform(apply_patch 等)在 chat 通道无法使用,丢弃(与顶层 type 过滤一致)。
            None
        }
        "namespace" => {
            // 命名空间工具 → 每个子 function 拍平为 `namespace.name`,
            // 工具调用时反向映射为 namespace 项(v1 尽量覆盖)。
            let ns = tool.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let children = tool
                .get("tools")
                .or_else(|| tool.get("children"))
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut out = Vec::new();
            for child in children {
                if let Some(mut f) = responses_tool_to_chat_tool(&child) {
                    let nm = child.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    f["function"]["name"] = json!(format!("{}.{}", ns, nm));
                    out.push(f);
                }
            }
            if out.len() == 1 {
                out.pop()
            } else if out.is_empty() {
                None
            } else {
                None // 多子函数的 namespace 展开为多工具,由上层处理
            }
        }
        _ => None,
    }
}

/// Responses 请求体 → Chat Completions 请求体。
pub fn responses_to_chat(body: &Value) -> Value {
    let mut out = serde_json::Map::new();

    if let Some(m) = body.get("model") {
        out.insert("model".into(), m.clone());
    }

    let mut messages: Vec<Value> = Vec::new();

    // instructions(顶层)→ system 消息
    if let Some(inst) = body.get("instructions").and_then(|v| v.as_str()) {
        if !inst.trim().is_empty() {
            messages.push(json!({"role": "system", "content": inst}));
        }
    }

    if let Some(input) = body.get("input").and_then(|v| v.as_array()) {
        for item in input {
            let typ = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match typ {
                "message" => {
                    let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                    let content = item.get("content").cloned().unwrap_or_else(|| json!([]));
                    let chat_content = message_content_to_chat(&content);
                    messages.push(json!({"role": role_to_chat_role(role), "content": chat_content}));
                }
                "function_call" => {
                    let call_id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let arguments = item
                        .get("arguments")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "{}".into());
                    messages.push(json!({
                        "role": "assistant",
                        "content": Value::Null,
                        "tool_calls": [{
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": arguments}
                        }]
                    }));
                }
                "function_call_output" => {
                    let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                    let output = item.get("output").map(|v| {
                        v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string())
                    }).unwrap_or_else(|| String::new());
                    messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": output}));
                }
                "reasoning" | "additional_tools" => { /* 丢弃:chat 无对应内容项 */ }
                _ => {}
            }
        }
    }

    out.insert("messages".into(), json!(messages));

    // 工具:顶层 tools(标准映射)
    if let Some(tools) = body.get("tools").and_then(|v| v.as_array()) {
        let mut out_tools: Vec<Value> = Vec::new();
        for t in tools {
            let typ = t.get("type").and_then(|v| v.as_str()).unwrap_or("");
            // chat 上游只接受 function；Codex 的 custom(freeform apply_patch)/web_search/
            // tool_search 在 chat 通道无法使用,直接丢弃(对齐 cc-switch ProxyChat 型档)。
            if typ != "function" && typ != "namespace" {
                continue;
            }
            if typ == "namespace" {
                let ns = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let children = t
                    .get("tools")
                    .or_else(|| t.get("children"))
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for child in children {
                    if let Some(mut f) = responses_tool_to_chat_tool(&child) {
                        let nm = child.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        // OpenAI 兼容 function name 仅允许 ^[a-zA-Z0-9_-]+$ 且 <=64;
                        // 用 __ 连接(namespace 本身可含 __,如 mcp__x,故反向用最后一个 __ 切分)。
                        let flat = format!("{}__{}", ns, nm);
                        if flat.len() > CHAT_TOOL_NAME_MAX_LEN {
                            continue; // 超长直接丢弃该子工具,避免发畸形工具名导致上游 400
                        }
                        f["function"]["name"] = json!(flat);
                        out_tools.push(f);
                    }
                }
            } else if let Some(f) = responses_tool_to_chat_tool(t) {
                out_tools.push(f);
            }
        }
        if !out_tools.is_empty() {
            out.insert("tools".into(), json!(out_tools));
        }
    }

    // tool_choice 透传(Responses 与 chat 同构:{"type":"function","function":{...}})
    if let Some(tc) = body.get("tool_choice") {
        out.insert("tool_choice".into(), tc.clone());
    }

    // max_output_tokens → max_completion_tokens(gpt-5/o 系)或 max_tokens
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let ml = model.to_lowercase();
    if let Some(m) = body.get("max_output_tokens") {
        let key = if ml.starts_with("o") || ml.contains("gpt-5") { "max_completion_tokens" } else { "max_tokens" };
        out.insert(key.into(), m.clone());
    }

    // 注意:不把 responses 的 reasoning.effort 转成 chat reasoning_effort。
    // 各上游的"思考档位"参数不同(deepseek/glm 各自 thinking 参数、gemini 用
    // thinkingConfig,且拒收 "none"→THINKING_LEVEL_MINIMAL),外包会跨厂商报 400;
    // 让上游走默认思考即可,通用桥接最稳。

    for k in ["temperature", "top_p", "stream"] {
        if let Some(v) = body.get(k) {
            out.insert(k.into(), v.clone());
        }
    }

    // 流式时让上游回传 usage 到最后一个 SSE 块
    if body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false) {
        out.insert("stream_options".into(), json!({"include_usage": true}));
    }

    Value::Object(out)
}

// ---------------------------------------------------------------------------
// Chat → Responses(响应方向,非流式)
// ---------------------------------------------------------------------------

fn chat_usage_to_responses(usage: Option<&Value>) -> Value {
    let Some(u) = usage.filter(|v| v.is_object()) else {
        return json!({
            "input_tokens": 0,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 0,
            "total_tokens": 0,
            "output_tokens_details": {"reasoning_tokens": 0},
            "cached_tokens": 0
        });
    };
    let num = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let input = num("prompt_tokens");
    let output = num("completion_tokens");
    let cached = u
        .pointer("/prompt_tokens_details/cached_tokens")
        .or_else(|| u.pointer("/input_tokens_details/cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_write = u
        .pointer("/prompt_tokens_details/cache_write_tokens")
        .or_else(|| u.pointer("/input_tokens_details/cache_write_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let reasoning = u
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    json!({
        "input_tokens": input,
        "output_tokens": output,
        "total_tokens": num("total_tokens"),
        "cached_tokens": cached,
        "input_tokens_details": {"cached_tokens": cached, "cache_write_tokens": cache_write},
        "output_tokens_details": {"reasoning_tokens": reasoning}
    })
}

fn finish_status(finish_reason: Option<&str>) -> &'static str {
    match finish_reason {
        Some("length") => "incomplete",
        _ => "completed",
    }
}

/// chat message(assistant)+tool_calls → responses output items。
pub fn chat_message_to_output_items(
    message: &Value,
    model: &str,
    start: usize,
) -> Vec<Value> {
    let mut out = Vec::new();
    let content = message.get("content");
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    if !text.is_empty() {
        out.push(json!({
            "type": "message",
            "id": next_id("msg"),
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": text, "annotations": []}]
        }));
    }
    if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for (i, tc) in calls.iter().enumerate() {
            let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("");
            let arguments = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()).unwrap_or("{}");
            let (final_name, ns) = match name.rfind("__") {
                Some(sep) => (name[sep + 2..].to_string(), name[..sep].to_string()),
                None => (name.to_string(), String::new()),
            };
            let mut item = json!({
                "type": "function_call",
                "id": next_id("fc"),
                "call_id": if call_id.is_empty() { format!("fc_{}", next_id("")) } else { call_id.to_string() },
                "arguments": arguments,
                "status": "completed",
                "name": final_name,
            });
            if !ns.is_empty() {
                item["namespace"] = json!(ns);
            }
            let _ = start;
            let _ = i;
            out.push(item);
        }
    }
    let _ = model;
    out
}

/// chat 完成响应(非流式)→ responses 响应对象。
pub fn chat_to_responses_json(chat: &Value, model: &str) -> Value {
    let finish = chat
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("finish_reason"))
        .and_then(|v| v.as_str());
    let message = chat
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"));
    let mut output: Vec<Value> = Vec::new();
    if let Some(m) = message {
        output = chat_message_to_output_items(m, model, 0);
    }
    if let Some(err) = chat.get("error") {
        return json!({
            "id": next_id("resp"),
            "object": "response",
            "created_at": chrono_ts(),
            "status": "failed",
            "model": model,
            "error": err,
            "output": []
        });
    }
    json!({
        "id": next_id("resp"),
        "object": "response",
        "created_at": chrono_ts(),
        "status": finish_status(finish),
        "model": model,
        "output": output,
        "usage": chat_usage_to_responses(chat.get("usage"))
    })
}

fn chrono_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Chat SSE → Responses SSE(流式方向)
// ---------------------------------------------------------------------------

fn sse_event(ev: &str, data: Value) -> Bytes {
    Bytes::from(format!("event: {ev}\ndata: {}\n\n", data.to_string()))
}

/// 把上游 chat SSE 字节流转换为 responses SSE 事件流。
pub fn transform_chat_sse<S>(input: S, model: String) -> impl Stream<Item = Bytes>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    use async_stream::stream;
    use futures_util::StreamExt;

    stream! {
        let mut buf = String::new();
        let mut started = false;
        // 组装中的 items
        let mut output_items: Vec<Value> = Vec::new();
        let mut text_item: Option<Value> = None; // active message item
        let mut text_buf = String::new();
        let mut tool_items: HashMap<usize, Value> = HashMap::new(); // chat index -> function_call item
        let mut tool_args: HashMap<usize, String> = HashMap::new();
        let mut finish_reason: Option<String> = None;
        let mut usage: Option<Value> = None;
        let mut failed: Option<Value> = None;
        let mut saw_final = false;

        let meta_id = next_id("resp");

        let mut input = Box::pin(input);
        while let Some(chunk) = input.next().await {
            match chunk {
                Err(e) => {
                    yield sse_event("response.failed", json!({
                        "type": "response.failed",
                        "response": {"id": meta_id, "object": "response", "status": "failed", "model": model,
                                      "error": {"type": "upstream_error", "message": format!("upstream stream error: {e}")}}
                    }));
                    return;
                }
                Ok(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    if !started {
                        started = true;
                        yield sse_event("response.created", json!({
                            "type": "response.created",
                            "response": {"id": meta_id, "object": "response", "created_at": chrono_ts(), "status": "in_progress", "model": model, "output": []}
                        }));
                        yield sse_event("response.in_progress", json!({"type": "response.in_progress"}));
                    }
                    // 按行处理(SSE 以 \n\n 分块,但逐行更稳)
                    while let Some(idx) = buf.find('\n') {
                        let line: String = buf.drain(..=idx).collect();
                        let line = line.trim_end_matches('\r');
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data.is_empty() { continue; }
                        if data == "[DONE]" {
                            saw_final = true;
                            break;
                        }
                        let Ok(j) = serde_json::from_str::<Value>(data) else { continue };
                        if let Some(err) = j.get("error") {
                            failed = Some(err.clone());
                            break;
                        }
                        // usage 块(带 stream_options include_usage)
                        if let Some(u) = j.get("usage") {
                            usage = Some(u.clone());
                        }
                        let Some(choice) = j.get("choices").and_then(|v| v.as_array()).and_then(|a| a.first()).cloned() else { continue };
                        if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                            if !fr.is_empty() { finish_reason = Some(fr.to_string()); }
                        }
                        let Some(delta) = choice.get("delta") else { continue };

                        // 文本增量
                        if let Some(t) = delta.get("content").and_then(|v| v.as_str()) {
                            if !t.is_empty() {
                                if text_item.is_none() {
                                    let item = json!({
                                        "type": "message", "id": next_id("msg"), "status": "in_progress",
                                        "role": "assistant", "content": []
                                    });
                                    text_item = Some(item.clone());
                                    yield sse_event("response.output_item.added", json!({
                                        "type": "response.output_item.added", "output_index": output_items.len(),
                                        "item": item
                                    }));
                                    yield sse_event("response.content_part.added", json!({
                                        "type": "response.content_part.added", "item_id": item["id"], "output_index": output_items.len(),
                                        "content_index": 0,
                                        "part": {"type": "output_text", "text": "", "annotations": []}
                                    }));
                                }
                                text_buf.push_str(t);
                                yield sse_event("response.output_text.delta", json!({
                                    "type": "response.output_text.delta", "item_id": text_item.as_ref().unwrap()["id"],
                                    "output_index": output_items.len(), "content_index": 0, "delta": t
                                }));
                            }
                        }

                        // 工具调用增量
                        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                            for tc in calls {
                                let Some(idx) = tc.get("index").and_then(|v| v.as_u64()).map(|x| x as usize) else { continue };
                                if !tool_items.contains_key(&idx) {
                                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                    let name = tc.get("function").and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                                    let mut item = json!({
                                        "type": "function_call", "id": next_id("fc"),
                                        "call_id": if id.is_empty() { next_id("fc") } else { id.to_string() },
                                        "arguments": "", "status": "in_progress", "name": name
                                    });
                                    // 拍平名字还原 namespace:chat 名 "ns__func" → responses namespace 项
                                    if let Some(sep) = name.rfind("__") {
                                        item["name"] = json!(name[sep + 2..].to_string());
                                        item["namespace"] = json!(name[..sep].to_string());
                                    }
                                    tool_items.insert(idx, item.clone());
                                    tool_args.insert(idx, String::new());
                                    yield sse_event("response.output_item.added", json!({
                                        "type": "response.output_item.added",
                                        "output_index": output_items.len() + tool_items.len() - 1,
                                        "item": item
                                    }));
                                }
                                if let Some(args) = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()) {
                                    tool_args.get_mut(&idx).map(|s| s.push_str(args));
                                    yield sse_event("response.function_call_arguments.delta", json!({
                                        "type": "response.function_call_arguments.delta",
                                        "item_id": tool_items[&idx]["id"],
                                        "output_index": output_items.len() + tool_items.len() - 1,
                                        "arguments": args
                                    }));
                                }
                            }
                        }
                    }
                    if saw_final { break; }
                    if failed.is_some() { break; }
                }
            }
        }

        // 收尾:完成挂起 items
        if let Some(mut item) = text_item.take() {
            item["status"] = json!("completed");
            item["content"] = json!([{"type": "output_text", "text": text_buf, "annotations": []}]);
            yield sse_event("response.content_part.done", json!({
                "type": "response.content_part.done", "item_id": item["id"], "output_index": output_items.len(), "content_index": 0
            }));
            yield sse_event("response.output_item.done", json!({"type": "response.output_item.done", "output_index": output_items.len(), "item": item}));
            output_items.push(item);
        }
        let mut idxs: Vec<usize> = tool_items.keys().cloned().collect();
        idxs.sort_unstable();
        for idx in idxs {
            if let Some(mut item) = tool_items.remove(&idx) {
                item["status"] = json!("completed");
                item["arguments"] = json!(tool_args.remove(&idx).unwrap_or_default());
                yield sse_event("response.output_item.done", json!({
                    "type": "response.output_item.done", "output_index": output_items.len(), "item": item
                }));
                output_items.push(item);
            }
        }

        let status = if failed.is_some() { "failed" } else { finish_status(finish_reason.as_deref()) };
        let mut resp = json!({
            "id": meta_id, "object": "response", "created_at": chrono_ts(), "status": status,
            "model": model, "output": output_items
        });
        // usage 恒用完整默认(缺失时补 input_tokens 等全字段):部分上游(如 grok/xAI)的
        // chat SSE 不返回 usage,若不补全,桌面端(内嵌 codex)解析 response.completed 会报
        // "missing field `input_tokens`"。
        resp["usage"] = chat_usage_to_responses(usage.as_ref());
        if let Some(err) = failed.take() {
            resp["error"] = err;
        }
        yield sse_event("response.completed", json!({"type": "response.completed", "response": resp}));
    }
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ProxyState {
    pub upstream_base_url: String,
    pub convert_pattern: String,
    /// 本地 codex 模型目录(models.json,即 Codex 内部目录 schema)。
    /// 设置后 GET /models 直接返回它(网关返回的标准 OpenAI 列表不在 Codex
    /// ModelsResponse 反序列化范围内,会导致模型切换器只剩内置模型)。
    pub models_json_path: Option<String>,
    pub client: reqwest::Client,
}

pub fn build_app(upstream_base_url: String, convert_pattern: String, models_json_path: Option<String>) -> Router {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .unwrap_or_default();
    let state = ProxyState { upstream_base_url, convert_pattern, models_json_path, client };
    Router::new()
        .route("/healthz", get(handle_health))
        .route("/models", get(handle_models))
        .route("/api/v1/models", get(handle_models))
        .route("/responses", post(handle_responses))
        .route("/api/v1/responses", post(handle_responses))
        .with_state(state)
}

async fn handle_health() -> Json<Value> {
    Json(json!({"ok": true}))
}

/// 读取本地模型目录内容(用于 GET /models 直接回放),返回 (etag, body)。
fn serve_local_models_catalog(models_json_path: &str) -> Option<(String, String)> {
    let content = std::fs::read_to_string(models_json_path).ok()?;
    let body = content.trim().to_string();
    if body.is_empty() {
        return None;
    }
    // 简单 etag:基于内容长度 + 修改时间的弱哈希,避免每次全量比较
    let meta = std::fs::metadata(models_json_path).ok();
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Some((format!("\"{:x}-{mtime:x}\"", body.len()), body))
}

async fn handle_models(
    State(st): State<ProxyState>,
    headers: HeaderMap,
) -> Response {
    // 首选:本地模型目录(Codex 内部 schema;网关的标准 OpenAI 列表反序列化会静默失败)
    if let Some(path) = st.models_json_path.as_deref() {
        if let Some((etag, body)) = serve_local_models_catalog(path) {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ETAG, etag)
                .header("cache-control", "no-cache")
                .body(Body::from(body))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
        }
    }
    let url = format!("{}/models", st.upstream_base_url.trim_end_matches('/'));
    let mut req = st.client.get(&url);
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        if let Ok(v) = auth.to_str() {
            req = req.header(header::AUTHORIZATION, v);
        }
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let content_type = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            match resp.bytes().await {
                Ok(b) => Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(b))
                    .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()),
                Err(e) => json_err(502, format!("upstream read failed: {e}")),
            }
        }
        Err(e) => json_err(502, format!("upstream connect failed: {e}")),
    }
}

fn json_err(status: u16, msg: String) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
        Json(json!({"error": {"message": msg, "type": "proxy_error"}})),
    )
        .into_response()
}

async fn handle_responses(
    State(st): State<ProxyState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let convert = should_convert(&model, &st.convert_pattern);
    let stream_req = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

    let (target, out_body) = if convert {
        (format!("{}/chat/completions", st.upstream_base_url.trim_end_matches('/')), responses_to_chat(&body))
    } else {
        (format!("{}/responses", st.upstream_base_url.trim_end_matches('/')), body.clone())
    };

    let mut req = st.client.post(&target).body(out_body.to_string());
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        if let Ok(v) = auth.to_str() {
            req = req.header(header::AUTHORIZATION, v);
        }
    }
    req = req
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream");

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => return json_err(502, format!("upstream connect failed: {e}")),
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !status.is_success() {
        // 非 2xx:原样透传错误(Codex 直接显示)
        return match upstream.bytes().await {
            Ok(b) => Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, if content_type.is_empty() { "application/json".to_string() } else { content_type.clone() })
                .body(Body::from(b))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()),
            Err(e) => json_err(502, format!("upstream read failed: {e}")),
        };
    }

    // 转换路径:chat SSE → responses SSE
    if convert {
        if stream_req && content_type.contains("text/event-stream") {
            let s = upstream
                .bytes_stream()
                .map(|b| b.map_err(|e| reqwest::Error::without_url(e)));
            let out = transform_chat_sse(s, model);
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header("cache-control", "no-cache")
                .body(Body::from_stream(out.map(Ok::<Bytes, Box<dyn std::error::Error + Send + Sync>>)))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
        }
        // 非流式或非 SSE 响应:整体转 JSON
        return match upstream.bytes().await {
            Ok(b) => match serde_json::from_slice::<Value>(&b) {
                Ok(v) => {
                    if v.get("error").is_some() {
                        // chat 错误体按 responses 错误包装
                        let id = next_id("resp");
                        let resp_err = json!({
                            "id": id, "object": "response", "status": "failed", "model": model,
                            "error": v.get("error").cloned().unwrap_or(v.clone()), "output": []
                        });
                        Json(resp_err).into_response()
                    } else {
                        Json(chat_to_responses_json(&v, &model)).into_response()
                    }
                }
                Err(_) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(b))
                    .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()),
            },
            Err(e) => json_err(502, format!("upstream read failed: {e}")),
        };
    }

    // 透传路径:原样转发
    if stream_req && content_type.contains("text/event-stream") {
        let s = upstream
            .bytes_stream()
            .map(|b| b.map(|x| x).map_err(|e| axum::Error::new(e)));
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from_stream(s))
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    }
    match upstream.bytes().await {
        Ok(b) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, if content_type.is_empty() { "application/json".to_string() } else { content_type })
            .body(Body::from(b))
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()),
        Err(e) => json_err(502, format!("upstream read failed: {e}")),
    }
}

// ---------------------------------------------------------------------------
// 进程生命周期
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProxyRunState {
    pub port: u16,
    pub pid: u32,
    pub upstream: String,
    pub pattern: String,
    /// 代理进程监听的地址列表(如 127.0.0.1 + ::1 或本机 LAN IP)。
    #[serde(default = "default_bind_ips")]
    pub bind_ips: Vec<String>,
    /// 写入 Codex 配置的 base_url 主机名(localhost | 127.0.0.1 | LAN IP)。
    #[serde(default = "default_codex_host")]
    pub codex_host: String,
    /// 本地模型目录路径(models.json);GET /models 直接回放它。
    #[serde(default)]
    pub models_json_path: Option<String>,
    /// 应用二进制戳(current_exe 的 mtime):app 升级后二进制变化 → 强制重启代理,
    /// 避免复用旧版二进制的代理进程(新修复不生效)。
    #[serde(default)]
    pub bin_stamp: Option<String>,
}

fn default_bind_ips() -> Vec<String> {
    vec!["127.0.0.1".to_string()]
}

fn default_codex_host() -> String {
    "localhost".to_string()
}

pub fn state_file_path(config_dir: &str) -> String {
    format!("{}/codex-proxy.json", config_dir.trim_end_matches('/'))
}

pub fn write_state(config_dir: &str, st: &ProxyRunState) -> Result<(), String> {
    let path = state_file_path(config_dir);
    let parent = std::path::Path::new(&path).parent().map(|p| p.to_path_buf());
    if let Some(p) = parent {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(st).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写入代理状态失败: {e}"))
}

pub fn read_state(config_dir: &str) -> Option<ProxyRunState> {
    let path = state_file_path(config_dir);
    std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

pub fn clear_state(config_dir: &str) {
    let _ = std::fs::remove_file(state_file_path(config_dir));
}

/// 拉起独立代理进程(当前可执行文件 + --proxy-server,脱离 GUI 独立运行)。
pub fn spawn_proxy(
    port: u16,
    bind_ips: &[String],
    codex_host: &str,
    upstream: &str,
    pattern: &str,
    models_json_path: Option<&str>,
) -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位自身可执行文件失败: {e}"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("--proxy-server")
        .arg(port.to_string())
        .arg(upstream.to_string())
        .arg(pattern.to_string())
        .arg(bind_ips.join(","))
        .arg(codex_host.to_string())
        .arg(models_json_path.unwrap_or("").to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("启动代理进程失败: {e}"))?;
    Ok(child.id())
}

pub fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("kill");
        cmd.arg("-0").arg(pid.to_string());
        return cmd.status().map(|s| s.success()).unwrap_or(false);
    }
    #[cfg(windows)]
    {
        let out = Command::new("tasklist").arg("/FI").arg(format!("PID eq {}", pid)).output();
        return out
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false);
    }
}

pub fn kill_proc(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let out = Command::new("kill").arg(pid.to_string()).output();
        out.map(|o| o.status.success()).unwrap_or(false)
    }
    #[cfg(windows)]
    {
        let out = Command::new("taskkill").arg("/PID").arg(pid.to_string()).arg("/F").output();
        out.map(|o| o.status.success()).unwrap_or(false)
    }
}

/// 当前应用二进制戳(current_exe 的修改时间毫秒)。升级后二进制 mtime 变化,
/// 用于让代理自愈时感知"代码已更新",强制用新二进制重启代理。
pub fn current_bin_stamp() -> String {
    let exe = std::env::current_exe().ok();
    let mtime = exe
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{mtime}")
}

/// 健康检查:GET http://127.0.0.1:{port}/healthz。
pub fn health_check(ip: &str, port: u16) -> bool {
    let url = format!("http://{ip}:{port}/healthz");
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .timeout(std::time::Duration::from_secs(2))
        .build();
    agent.get(&url).call().map(|r| r.status() == 200).unwrap_or(false)
}

/// 启动并等待就绪;若已有健康实例直接复用。
pub fn ensure_running(
    config_dir: &str,
    port: u16,
    bind_ips: &[String],
    codex_host: &str,
    upstream: &str,
    pattern: &str,
    models_json_path: Option<&str>,
) -> Result<ProxyRunState, String> {
    let mjp = models_json_path.map(|p| p.to_string());
    let stamp = Some(current_bin_stamp());
    let health_target = if codex_host == "localhost" { "localhost" } else { codex_host };
    if health_check(health_target, port) {
        if let Some(st) = read_state(config_dir) {
            if st.upstream == upstream
                && st.pattern == pattern
                && st.codex_host == codex_host
                && st.bind_ips == bind_ips
                && st.models_json_path == mjp
                && st.bin_stamp == stamp
            {
                return Ok(st);
            }
        }
        // 有实例但不是我们要的配置或二进制已更新:重启
        let _ = stop(config_dir);
    }
    if let Some(st) = read_state(config_dir) {
        if is_pid_alive(st.pid) && st.port == port {
            // 进程在但健康检查失败(启动中?)再等一会
            for _ in 0..25 {
                if health_check(&st.codex_host, port) {
                    if st.upstream == upstream
                        && st.pattern == pattern
                        && st.codex_host == codex_host
                        && st.bind_ips == bind_ips
                        && st.models_json_path == mjp
                        && st.bin_stamp == stamp
                    {
                        return Ok(st);
                    }
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
        let _ = stop(config_dir);
    }
    let pid = spawn_proxy(port, bind_ips, codex_host, upstream, pattern, models_json_path)?;
    let st = ProxyRunState { port, pid, upstream: upstream.to_string(), pattern: pattern.to_string(), bind_ips: bind_ips.to_vec(), codex_host: codex_host.to_string(), models_json_path: mjp, bin_stamp: stamp };
    write_state(config_dir, &st)?;
    // 等就绪(最多 6s)
    for _ in 0..30 {
        if health_check(health_target, port) {
            return Ok(st);
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let _ = kill_proc(st.pid);
    let _ = clear_state(config_dir);
    Err(format!("代理启动超时(端口 {port} 可能被占用),请尝试换端口"))
}

pub fn stop(config_dir: &str) -> Result<(), String> {
    if let Some(st) = read_state(config_dir) {
        if is_pid_alive(st.pid) {
            let _ = kill_proc(st.pid);
        }
        clear_state(config_dir);
    }
    Ok(())
}

/// 独立运行模式入口(由 main.rs 在 --proxy-server 时调用,常驻)。
pub fn run_server_blocking(port: u16, bind_ips: Vec<String>, upstream: String, pattern: String, models_json_path: Option<String>) {
    let rt = tokio::runtime::Runtime::new().expect("failed to init tokio runtime");
    rt.block_on(async move {
        let app = build_app(upstream, pattern, models_json_path);
        let mut listeners = Vec::new();
        for ip in bind_ips {
            let addr: SocketAddr = format!("{ip}:{port}")
                .parse()
                .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port)));
            match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => listeners.push(l),
                Err(e) => eprintln!("proxy bind {addr} failed: {e}"),
            }
        }
        if listeners.is_empty() {
            return;
        }
        let mut futs = Vec::new();
        for l in listeners {
            let app = app.clone();
            futs.push(async move {
                let _ = axum::serve(l, app).await;
            });
        }
        futures_util::future::join_all(futs).await;
    });
}

// ---------------------------------------------------------------------------
// 系统代理劫持检测与兜底(仅 macOS;Windows 系统代理默认放行回环)
// ---------------------------------------------------------------------------

/// 当前生效的代理地址(env 优先,macOS 退到系统代理)。
fn current_proxy_url() -> Option<String> {
    for k in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"] {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    // macOS 系统代理(scutil --proxy)
    if let Ok(out) = Command::new("scutil").arg("--proxy").output() {
        let text = String::from_utf8_lossy(&out.stdout);
        let mut host: Option<String> = None;
        let mut port: Option<String> = None;
        for line in text.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("HTTPProxy : ") {
                host = Some(v.trim().to_string());
            } else if let Some(v) = line.strip_prefix("HTTPPort : ") {
                port = Some(v.trim().to_string());
            }
        }
        if let (Some(h), Some(p)) = (host, port) {
            if !h.is_empty() {
                return Some(format!("{h}:{p}"));
            }
        }
    }
    None
}

/// 用 codex 同款方式(默认 reqwest,含 env + macOS 系统代理自动检测)探测某地址可达性。
/// 结果反映「codex 进程视角」:若该地址被系统/环境代理劫持则探测失败。
pub fn probe_with_default_proxy(url: &str) -> bool {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(_) => return false,
    };
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(4))
            .build()
            .unwrap_or_default();
        match client.get(url).send().await {
            Ok(r) => r.status().as_u16() == 200,
            Err(_) => false,
        }
    })
}

/// 本机 LAN IPv4(优先 en0/en1;失败返回 None)。
fn lan_ip() -> Option<String> {
    for iface in ["en0", "en1", "en2", "eth0", "eth1"] {
        if let Ok(out) = Command::new("ipconfig").arg("getifaddr").arg(iface).output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && !s.starts_with("127.") {
                return Some(s);
            }
        }
    }
    // Windows 兜底:取第一个非回环 IPv4(v4 优先)
    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("powershell")
            .args(["-NoProfile", "-Command",
                "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown'} | Select-Object -First 1).IPAddress"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && !s.starts_with("127.") {
                return Some(s);
            }
        }
    }
    None
}

/// 通用自动选择(对任意代理端点/IP 有效):
/// 1. 默认用 `localhost` 主机名(标准环境 no_proxy 均含 localhost,天然绕过系统/环境代理劫持;
///    代理监听 127.0.0.1 + ::1 双栈回环);
/// 2. 若 localhost 也被劫持(罕见:no_proxy 连 localhost 都没有)→ 自动改绑本机 LAN IP,并把
///    base_url 写到 LAN 地址(劫持代理通常可达同网段本机);
/// 3. 仍不可达 → 返回可操作提示。
pub fn start_auto(
    config_dir: &str,
    port: u16,
    upstream: &str,
    pattern: &str,
    models_json_path: Option<&str>,
) -> Result<(ProxyRunState, Option<String>), String> {
    let loopback: Vec<String> = vec!["127.0.0.1".to_string(), "::1".to_string()];
    let st = ensure_running(config_dir, port, &loopback, "localhost", upstream, pattern, models_json_path)?;
    let mut note: Option<String> = None;
    if !probe_with_default_proxy(&format!("http://localhost:{port}/healthz")) {
        // localhost 被劫持:macOS 顺手写入 launchd no_proxy(新进程生效),再试 LAN 兜底
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("launchctl")
                .arg("setenv").arg("no_proxy").arg("127.0.0.1,localhost")
                .status();
        }
        if let Some(ip) = lan_ip() {
            let lan: Vec<String> = vec![ip.clone()];
            if probe_with_default_proxy(&format!("http://{ip}:{port}/healthz")) {
                let st2 = ensure_running(config_dir, port, &lan, &ip, upstream, pattern, models_json_path)?;
                note = Some(format!(
                    "检测到系统/环境代理劫持 localhost,已自动改用本机地址 {ip}:{port} 供 Codex 连接"
                ));
                return Ok((st2, note));
            }
        }
        note = Some(
            current_proxy_url()
                .map(|proxy| {
                    format!(
                        "检测到代理 {proxy} 劫持本地连接且无法自动兜底;请在系统代理设置中放行 127.0.0.1 与 localhost,或设置环境变量 no_proxy=127.0.0.1,localhost"
                    )
                })
                .unwrap_or_else(|| "本地代理探测异常,请检查端口占用".to_string()),
        );
    }
    Ok((st, note))
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream::iter;

    #[test]
    fn serve_local_models_catalog_reads_file() {
        let dir = std::env::temp_dir().join("axon-proxy-models-test.json");
        let content = "{\"models\":[{\"slug\":\"glm-5.3-flash\",\"context_window\":1000000}]}";
        std::fs::write(&dir, content).unwrap();
        let got = serve_local_models_catalog(dir.to_str().unwrap());
        assert!(got.is_some());
        let (etag, body) = got.unwrap();
        assert!(body.contains("glm-5.3-flash"));
        assert!(etag.starts_with('"'));
        // 相同路径再次读取 etag 一致
        let (etag2, _) = serve_local_models_catalog(dir.to_str().unwrap()).unwrap();
        assert_eq!(etag, etag2);
        // 不存在/空路径 → None
        assert!(serve_local_models_catalog("/nonexistent/xyz.json").is_none());
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn should_convert_matches_pattern() {
        assert!(should_convert("gpt-5.6-luna", "gpt-5.6"));
        assert!(should_convert("openai/gpt-5.6-sol", "gpt-5.6"));
        assert!(should_convert("GPT-5.6-TERRA", "gpt-5.6"));
        assert!(!should_convert("deepseek-v4-flash", "gpt-5.6"));
        assert!(!should_convert("qwen3.8-max", "gpt-5.6"));
    }

    #[test]
    fn responses_to_chat_basic_mapping() {
        let body = json!({
            "model": "gpt-5.6-luna",
            "instructions": "be concise",
            "input": [
                {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "you are codex"}]},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "input_text", "text": "ok"}]}
            ],
            "tools": [
                {"type": "function", "name": "exec_command", "description": "run", "parameters": {"type": "object", "properties": {}}}
            ],
            "max_output_tokens": 1000,
            "stream": true
        });
        let chat = responses_to_chat(&body);
        assert_eq!(chat["model"], "gpt-5.6-luna");
        let msgs = chat["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0]["role"], "system"); // instructions
        assert_eq!(msgs[0]["content"], "be concise");
        assert_eq!(msgs[1]["role"], "system"); // developer
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[3]["role"], "assistant");
        assert_eq!(chat["max_completion_tokens"], 1000);
        assert_eq!(chat["stream"], true);
        assert_eq!(chat["stream_options"]["include_usage"], true);
        let tools = chat["tools"].as_array().unwrap();
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "exec_command");
        // 工具定义必须在顶层 tools,严禁进 messages content
        assert!(!chat["messages"].to_string().contains("exec_command"));
    }

    #[test]
    fn responses_to_chat_tool_roundtrip_items() {
        let body = json!({
            "model": "gpt-5.6-luna",
            "input": [
                {"type": "function_call", "id": "fc_1", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
                {"type": "function_call_output", "call_id": "fc_1", "output": "file1"}
            ]
        });
        let chat = responses_to_chat(&body);
        let msgs = chat["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "assistant");
        assert_eq!(msgs[0]["tool_calls"][0]["id"], "fc_1");
        assert_eq!(msgs[0]["tool_calls"][0]["function"]["name"], "exec_command");
        assert_eq!(msgs[1]["role"], "tool");
        assert_eq!(msgs[1]["tool_call_id"], "fc_1");
        assert_eq!(msgs[1]["content"], "file1");
    }

    #[test]
    fn namespace_tools_flatten() {
        let body = json!({
            "model": "gpt-5.6-sol",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "tools": [
                {"type": "namespace", "name": "mcp__git", "tools": [
                    {"type": "function", "name": "status", "description": "git status", "parameters": {}}
                ]}
            ]
        });
        let chat = responses_to_chat(&body);
        let tools = chat["tools"].as_array().unwrap();
        assert_eq!(tools[0]["function"]["name"], "mcp__git__status");
    }

    #[test]
    fn chat_to_responses_json_basic() {
        let chat = json!({
            "id": "chatcmpl-x",
            "choices": [{
                "message": {"role": "assistant", "content": "hello world"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        });
        let r = chat_to_responses_json(&chat, "gpt-5.6-luna");
        assert_eq!(r["status"], "completed");
        assert_eq!(r["model"], "gpt-5.6-luna");
        assert_eq!(r["output"][0]["type"], "message");
        assert_eq!(r["output"][0]["content"][0]["type"], "output_text");
        assert_eq!(r["output"][0]["content"][0]["text"], "hello world");
        assert_eq!(r["usage"]["input_tokens"], 10);
    }

    #[test]
    fn chat_to_responses_json_tool_calls() {
        let chat = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {"id": "call_1", "type": "function", "function": {"name": "mcp__git__status", "arguments": "{}"}}
                    ]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let r = chat_to_responses_json(&chat, "gpt-5.6-sol");
        let item = &r["output"][0];
        assert_eq!(item["type"], "function_call");
        assert_eq!(item["name"], "status");
        assert_eq!(item["namespace"], "mcp__git");
        assert_eq!(item["call_id"], "call_1");
    }

    #[test]
    fn chat_conversion_omits_reasoning_effort() {
        let body = json!({
            "model": "gemini-3.7-flash",
            "reasoning": {"effort": "none", "summary": "detailed"},
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
        });
        let chat = responses_to_chat(&body);
        // Gemini 拒收 reasoning_effort:none(转 thinkingConfig 的 MINIMAL),桥接直接不外传
        assert!(chat.get("reasoning_effort").is_none());
    }

    #[test]
    fn chat_conversion_strips_custom_and_guards_long_names() {
        let long_name = "a".repeat(70);
        let body = json!({
            "model": "glm-5.3-flash",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "tools": [
                {"type": "function", "name": "ok_tool", "description": "d", "parameters": {"type": "object", "properties": {}}},
                {"type": "custom", "name": "apply_patch", "description": "freeform", "input_schema": {"type": "object"}},
                {"type": "web_search", "external_web_access": false},
                {"type": "tool_search", "name": "ts", "description": "x"},
                {"type": "namespace", "name": "mcp__git", "tools": [
                    {"type": "function", "name": "status", "description": "git status", "parameters": {"type": "object", "properties": {}}},
                    {"type": "function", "name": &long_name, "description": "too long", "parameters": {"type": "object", "properties": {}}}
                ]}
            ]
        });
        let chat = responses_to_chat(&body);
        let tools = chat["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().filter_map(|t| t["function"]["name"].as_str()).collect();
        assert!(names.contains(&"ok_tool"));
        assert!(names.contains(&"mcp__git__status"));
        // custom / web_search / tool_search 一律丢弃;超长命名空间子工具丢弃
        assert!(!names.iter().any(|n| n.contains(&"apply_patch")));
        assert!(!names.iter().any(|n| n.contains(&&long_name[..10])));
        assert_eq!(tools.len(), 2);
    }

    #[tokio::test]
    async fn chat_sse_transforms_to_responses_events() {
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")),
            Ok(Bytes::from("data: [DONE]\n\n")),
        ];
        let s = transform_chat_sse(iter(chunks), "gpt-5.6-luna".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        assert!(text.contains("event: response.created"));
        assert!(text.contains("event: response.output_text.delta"));
        assert!(text.contains("\"delta\":\"Hel\""));
        assert!(text.contains("event: response.completed"));
        assert!(text.contains("\"status\":\"completed\""));
        // usage 恒带全量字段(上游若未回传 usage,也不得缺 input_tokens 等,否则桌面端解析失败)
        assert!(text.contains("\"input_tokens\":0"));
        assert!(text.contains("\"output_tokens\":0"));
        // 工具定义从不进入 messages content
        assert!(!text.contains("additional_tools"));
    }

    #[tokio::test]
    async fn chat_sse_transforms_tool_arguments_deltas() {
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_x\",\"type\":\"function\",\"function\":{\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"ls\\\"}\"}}]},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\" -la\"}}]},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n")),
            Ok(Bytes::from("data: [DONE]\n\n")),
        ];
        let s = transform_chat_sse(iter(chunks), "gpt-5.6-sol".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        assert!(text.contains("event: response.function_call_arguments.delta"));
        assert!(text.contains("function_call"));
        assert!(text.contains("\"status\":\"completed\""));
    }
}