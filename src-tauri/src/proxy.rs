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
pub const DEFAULT_CONVERT_PATTERN: &str = "gpt-5.6|gpt-6|glm|kimi-k2.6|kimi-k3|kimi-lastest|step-3.7|MiMo|grok-4.6|claude-sonnet-5|claude-opus-5|gemini-3|deepseek-v4-flash";

/// 网关 chat 路由上「function tools 与 reasoning_effort 互斥」且「省略该参数按非 none
/// 默认处理」的模型族(实测 2026-09-24 迈金网关 gpt-6-luna,owned_by 七牛:tools + 省略
/// /low/medium/high 一律 400「Function tools with reasoning_effort are not supported for
/// gpt-6-luna in /v1/chat/completions」;tools + 显式 none 才正常出 tool_calls)。
/// Codex 每个请求都带 tools,所以该族在转换路径上必须显式发 "none" —— 沿用「none 一律
/// 省略」的旧规则正好落进 400 那一侧。
const TOOLS_EFFORT_EXCLUSIVE_PATTERN: &str = "gpt-6";

/// 流式请求的「上游响应头 / 首字节」deadline。实测该网关会挂住流式请求 30~60s 零字节
/// (HTTP 状态都不回),而 client 总超时是 600s —— 等于永远等不到。取 60s:成功样本首字节
/// 3.5s,而 1M 上下文的 Codex 大 prompt 预填确实可能要几十秒,压到 20s 会误杀正常慢启动。
const STREAM_FIRST_BYTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

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

/// 模型在网关 chat 路由上是否「tools × reasoning_effort 互斥,且省略即非 none 默认」。
fn tools_effort_exclusive(model: &str) -> bool {
    should_convert(model, TOOLS_EFFORT_EXCLUSIVE_PATTERN)
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
            // output_text/summary_text 出现在回放的历史里:Codex 把上一轮 assistant
            // 消息按 Responses 输出线形(output_text parts)原样回传;只认 input_text
            // 会把整段历史丢成空 content(模型看不到自己说过什么,严格上游还会拒收
            // 空 assistant 消息)。
            "input_text" | "output_text" | "summary_text" => {
                if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                    parts.push(json!({"type": "text", "text": t}));
                }
            }
            "refusal" => {
                // 历史里的拒答文案当正文带入(chat 无 refusal 概念)
                if let Some(r) = p.get("refusal").and_then(|v| v.as_str()) {
                    parts.push(json!({"type": "text", "text": r}));
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
            f.insert("parameters".into(), with_object_type(tool.get("parameters")));
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

/// 工具 schema 兜底:若干上游要求 `parameters` 带顶层 `type:"object"`。
/// 缺省/空 schema 补最小对象;已有 type 或非对象 schema 原样透传。
fn with_object_type(p: Option<&Value>) -> Value {
    match p {
        None | Some(Value::Null) => json!({"type": "object"}),
        Some(Value::Object(m)) => {
            if m.contains_key("type") {
                Value::Object(m.clone())
            } else {
                let mut m = m.clone();
                m.insert("type".into(), json!("object"));
                Value::Object(m)
            }
        }
        Some(other) => other.clone(),
    }
}

/// tool_choice 归一化为 chat 形态。字符串形 auto/none/required 原样;对象形:
/// Responses 扁平 `{"type":"function","name":…}` 要嵌进 chat 的 `function` 子对象,
/// Cursor 系 `{"type":"tool"|"any"}` → "required"。特别注意 `{"type":"none"}` 不能
/// 降级成 auto —— 那会把客户端明确禁用的工具重新打开。
fn tool_choice_to_chat(tc: &Value) -> Value {
    if let Some(s) = tc.as_str() {
        return match s {
            "auto" | "none" | "required" => json!(s),
            _ => json!("auto"),
        };
    }
    match tc.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "auto" | "none" => json!(tc.get("type").and_then(|v| v.as_str()).unwrap_or("auto")),
        "required" | "tool" | "any" => json!("required"),
        "function" => {
            let name = tc
                .get("function")
                .and_then(|v| v.get("name"))
                .or_else(|| tc.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if name.is_empty() {
                json!("required")
            } else {
                json!({"type": "function", "function": {"name": name}})
            }
        }
        _ => json!("auto"),
    }
}

/// function_call_output 的 output(string 或 parts 数组)→ chat tool 消息 content。
/// 图片 part 转 image_url,文本类 part 转 text;空 parts 退化为空字符串。
fn tool_output_to_chat(output: Option<&Value>) -> Value {
    match output {
        Some(Value::Array(parts)) => {
            let mut chat_parts: Vec<Value> = Vec::new();
            for p in parts {
                match p.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "input_image" | "output_image" | "image_url" => {
                        let url = p
                            .get("image_url")
                            .and_then(|v| v.as_str())
                            .or_else(|| p.get("data").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        chat_parts.push(json!({"type": "image_url", "image_url": {"url": url}}));
                    }
                    _ => {
                        if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                            chat_parts.push(json!({"type": "text", "text": t}));
                        }
                    }
                }
            }
            if chat_parts.is_empty() {
                Value::String(String::new())
            } else {
                json!(chat_parts)
            }
        }
        Some(Value::String(s)) => Value::String(s.clone()),
        Some(v) => Value::String(v.to_string()),
        None => Value::String(String::new()),
    }
}

/// system 消息的文本(用于"instructions 是否已在输入里"比较;content 可能是字符串或 parts)。
fn system_message_text(m: &Value) -> Option<String> {
    if m.get("role").and_then(|v| v.as_str()) != Some("system") {
        return None;
    }
    Some(match m.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    })
}

/// Responses 的 `response_format` / `text.format` → chat `response_format`。
/// json_schema 在 Responses 官方线形里是扁平的(name/schema/strict 直接挂在 format
/// 对象上;Codex 的结构化输出即 text.format 扁平形),chat 要求嵌进 `json_schema`
/// 子对象;两种嵌套都接受(嵌套形优先)。json_object / text 两边同构,原样带。
fn response_format_to_chat(body: &Value) -> Option<Value> {
    let raw = body
        .get("response_format")
        .filter(|v| v.is_object())
        .or_else(|| body.pointer("/text/format").filter(|v| v.is_object()))?;
    match raw.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "json_schema" => {
            let src = raw.get("json_schema").filter(|v| v.is_object()).unwrap_or(raw);
            let schema = src.get("schema")?; // 缺 schema 构不成合法 chat 请求 → 不映射
            // chat 校验 name 非空(Codex guardian 的 text.format 就不带 name;
            // 名字只用于展示,对约束无影响)
            let name = src
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("final_output");
            let mut js = serde_json::Map::new();
            js.insert("name".into(), json!(name));
            js.insert("schema".into(), schema.clone());
            if let Some(strict) = src.get("strict") {
                js.insert("strict".into(), strict.clone());
            }
            Some(json!({"type": "json_schema", "json_schema": js}))
        }
        "json_object" | "text" | "" => Some(raw.clone()),
        // 未知类型:宁可不带,也不把畸形参数发给上游换 400
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

    // input:item 数组(标准)或纯字符串(单轮 user);两者皆空时回退旧 prompt 字段
    let mut input_items: Vec<Value> = Vec::new();
    let mut input_str = String::new();
    match body.get("input") {
        Some(Value::Array(items)) => input_items = items.clone(),
        Some(Value::String(s)) => input_str = s.clone(),
        _ => {}
    }
    if input_items.is_empty() && input_str.is_empty() {
        match body.get("prompt") {
            Some(Value::Array(items)) => input_items = items.clone(),
            Some(Value::String(s)) => input_str = s.clone(),
            _ => {}
        }
    }
    if !input_str.is_empty() {
        messages.push(json!({"role": "user", "content": input_str}));
    }

    for item in &input_items {
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
                // 回放还原:响应方向把 chat 扁平名 `ns__func` 拆成 name + namespace
                // 两项(见 chat_message_to_output_items),Codex 回放时原样带回;
                // 这里必须拼回扁平名,否则上游 tools 列表里没有该名字(MCP 工具的
                // 第二轮调用会 400/历史错乱)。
                let raw_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let name = match item.get("namespace").and_then(|v| v.as_str()) {
                    Some(ns) if !ns.is_empty() && !raw_name.is_empty() => {
                        format!("{ns}__{raw_name}")
                    }
                    _ => raw_name.to_string(),
                };
                // arguments 正常是 JSON 字符串(原样透传,不再序列化 —— 否则 chat 上游
                // 收到 "\"{}\"" 双重编码);少数客户端发对象时序列化成字符串。
                let arguments = item
                    .get("arguments")
                    .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string()))
                    .unwrap_or_else(|| "{}".into());
                let tool_call = json!({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": arguments}
                });
                // 并行调用:Codex 把上一轮的 N 个 function_call 作为连续 item 回放;
                // chat 语义是「一条 assistant 消息 + N 个 tool_calls」,且严格上游
                // 拒收连续 assistant 回合 → 上一条是 assistant 时并入其 tool_calls。
                let mut merged = false;
                if let Some(last) = messages.last_mut().and_then(|m| m.as_object_mut()) {
                    if last.get("role").and_then(|v| v.as_str()) == Some("assistant") {
                        match last.get_mut("tool_calls").and_then(|v| v.as_array_mut()) {
                            Some(arr) => arr.push(tool_call.clone()),
                            None => {
                                last.insert("tool_calls".into(), json!([tool_call.clone()]));
                            }
                        }
                        merged = true;
                    }
                }
                if !merged {
                    messages.push(json!({
                        "role": "assistant",
                        "content": Value::Null,
                        "tool_calls": [tool_call]
                    }));
                }
            }
            "function_call_output" => {
                let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                let output = tool_output_to_chat(item.get("output"));
                messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": output}));
            }
            "reasoning" | "additional_tools" => { /* 丢弃:chat 无对应内容项 */ }
            _ => {}
        }
    }

    // instructions(顶层)→ 前置 system。与对照实现"输入里有 system 消息就跳过"不同,
    // 这里只在已存在**同文**system 消息时才跳过:Codex 的 base instructions 只走
    // instructions 字段,"存在 system 消息"并不等于"指令已在输入里",无条件跳过会把
    // 整个系统提示丢掉;而纯重复文案(客户端把 instructions 又抄进 input)才是要避免的。
    if let Some(inst) = body.get("instructions").and_then(|v| v.as_str()) {
        let inst = inst.trim();
        let already = messages
            .iter()
            .any(|m| system_message_text(m).as_deref() == Some(inst));
        if !inst.is_empty() && !already {
            messages.insert(0, json!({"role": "system", "content": inst}));
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

    // tool_choice 归一化(Responses 扁平形 → chat 嵌套形;none 不得降级为 auto)
    if let Some(tc) = body.get("tool_choice") {
        out.insert("tool_choice".into(), tool_choice_to_chat(tc));
    }

    // 结构化输出:text.format(Codex 结构化输出/guardian 走这条)或 response_format
    if let Some(rf) = response_format_to_chat(body) {
        out.insert("response_format".into(), rf);
    }

    // max_output_tokens → max_completion_tokens(gpt-5/gpt-6/o 系)或 max_tokens
    // (gpt-6 实测只收 max_completion_tokens,发 max_tokens 直接 400)
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let ml = model.to_lowercase();
    if let Some(m) = body.get("max_output_tokens") {
        let key = if ml.starts_with("o") || ml.contains("gpt-5") || ml.contains("gpt-6") { "max_completion_tokens" } else { "max_tokens" };
        out.insert(key.into(), m.clone());
    }

    // reasoning.effort → chat reasoning_effort:网关对各厂商会自行转成对应思考参数
    // (实测 deepseek/glm/kimi/gemini/gpt-5.6 等全模型接受 low/high/max)。
    // 唯 "none"/"off"/"disabled" 不作为该参数发送:实测 claude-* / gemini-3.7-flash /
    // grok-4.6 拒收 "none"(报 Invalid reasoning_effort / THINKING_LEVEL_MINIMAL),
    // 发送则 400;改用 omit(让上游走默认),安全且不崩。
    // 例外见下面 tools_effort_exclusive 分支:对 gpt-6 族「省略」恰恰是坏形状。
    let has_tools = out.contains_key("tools");
    if has_tools && tools_effort_exclusive(model) {
        // 该族在 chat 路由上 tools×reasoning 互斥,且「省略」按非 none 处理 → 显式发 none
        // 是唯一可用形状。代价:Codex 侧这些模型不再思考(网关不支持,不是代理的选择)。
        out.insert("reasoning_effort".into(), json!("none"));
    } else if let Some(effort) = body
        .get("reasoning")
        .and_then(|v| v.get("effort"))
        .and_then(|v| v.as_str())
    {
        let e = effort.trim().to_ascii_lowercase();
        if !matches!(e.as_str(), "none" | "off" | "disabled") {
            out.insert("reasoning_effort".into(), json!(effort));
        }
    }

    // parallel_tool_calls / user 同名透传(Codex 必发 parallel_tool_calls)
    for k in ["temperature", "top_p", "stream", "parallel_tool_calls", "user"] {
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

/// 未完成原因(Responses 的 incomplete_details.reason)。Codex 只在
/// response.incomplete 事件上读它并向上抛错("Incomplete response returned,
/// reason: ..."),response.completed 的 status 字段它不解析。
fn incomplete_reason(finish_reason: Option<&str>) -> Option<&'static str> {
    match finish_reason {
        Some("length") => Some("max_output_tokens"),
        Some("content_filter") => Some("content_filter"),
        // refusal(拒答)也报 incomplete,但没有 details.reason(对齐 OpenAI 线形)
        _ => None,
    }
}

fn finish_status(finish_reason: Option<&str>) -> &'static str {
    match finish_reason {
        Some("length") | Some("content_filter") | Some("refusal") => "incomplete",
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
    // 思考内容(deepseek 系 message.reasoning_content / 部分网关 message.reasoning):
    // 转成 reasoning item,按 OpenAI 原生线形排在 message 之前。
    let think = message
        .get("reasoning_content")
        .and_then(|v| v.as_str())
        .or_else(|| message.get("reasoning").and_then(|v| v.as_str()))
        .unwrap_or("");
    if !think.is_empty() {
        out.push(json!({
            "type": "reasoning",
            "id": next_id("rs"),
            "status": "completed",
            "summary": [{"type": "summary_text", "text": think}]
        }));
    }
    let content = message.get("content");
    let mut text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    // 拒答文案并入正文(同流式:Codex 没有 refusal content part 变体)
    text.push_str(message.get("refusal").and_then(|v| v.as_str()).unwrap_or(""));
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
    let mut out = json!({
        "id": next_id("resp"),
        "object": "response",
        "created_at": chrono_ts(),
        "status": finish_status(finish),
        "model": model,
        "output": output,
        "usage": chat_usage_to_responses(chat.get("usage"))
    });
    if let Some(reason) = incomplete_reason(finish) {
        out["incomplete_details"] = json!({"reason": reason});
    }
    out
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

/// 关掉进行中的 reasoning item:返回 (事件类型, data) 列表与终态 item。
/// async_stream 的生成器里无法在闭包中 yield,故收尾事件收集后由调用方逐条发出。
/// 线形(空 summary 数组、summary_index、summary_text part)按 Codex 严格解析要求。
fn close_reasoning(item: Value, idx: usize, text: &str) -> (Vec<(&'static str, Value)>, Value) {
    let mut done = item.clone();
    done["status"] = json!("completed");
    done["summary"] = json!([{"type": "summary_text", "text": text}]);
    let events = vec![
        (
            "response.reasoning_summary_text.done",
            json!({
                "type": "response.reasoning_summary_text.done", "item_id": item["id"],
                "output_index": idx, "summary_index": 0, "text": text
            }),
        ),
        (
            "response.reasoning_summary_part.done",
            json!({
                "type": "response.reasoning_summary_part.done", "item_id": item["id"],
                "output_index": idx, "summary_index": 0,
                "part": {"type": "summary_text", "text": text}
            }),
        ),
        (
            "response.output_item.done",
            json!({"type": "response.output_item.done", "output_index": idx, "item": done.clone()}),
        ),
    ];
    (events, done)
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
        // 组装中的 items。每个 item 在"首次出现"时分配 output_index(单调递增),
        // 收尾时按其排序 —— 不能用 output_items.len() 现算:文字 item 挂起未入列时,
        // 工具调用算出的 added/delta 索引会和最终 done 索引错位。
        let mut next_index = 0usize; // 下一个待分配的 output_index
        let mut output_items: Vec<(usize, Value)> = Vec::new(); // (output_index, 终态 item)
        let mut reasoning_item: Option<Value> = None; // active reasoning item
        let mut reasoning_idx = 0usize;
        let mut reasoning_buf = String::new();
        let mut text_item: Option<Value> = None; // active message item
        let mut text_idx = 0usize;
        let mut text_buf = String::new();
        let mut tool_items: HashMap<usize, Value> = HashMap::new(); // chat index -> function_call item
        let mut tool_idx: HashMap<usize, usize> = HashMap::new(); // chat index -> output_index
        let mut tool_args: HashMap<usize, String> = HashMap::new();
        let mut finish_reason: Option<String> = None;
        let mut usage: Option<Value> = None;
        let mut failed: Option<Value> = None;
        let mut saw_final = false;

        let meta_id = next_id("resp");

        let mut input = Box::pin(input);
        let mut waiting_first = true;
        loop {
            // 只给「第一个字节」设 deadline(后续块不设:长回答正常就会几十秒不出块)。
            let chunk = if waiting_first {
                match tokio::time::timeout(STREAM_FIRST_BYTE_TIMEOUT, input.next()).await {
                    Ok(c) => c,
                    Err(_) => {
                        failed = Some(json!({
                            "type": "upstream_timeout",
                            "message": format!("upstream sent no SSE data within {}s (gateway hang)", STREAM_FIRST_BYTE_TIMEOUT.as_secs())
                        }));
                        break;
                    }
                }
            } else {
                input.next().await
            };
            waiting_first = false;
            let Some(chunk) = chunk else { break };
            match chunk {
                Err(e) => {
                    // 上游 SSE 流中断:设置 failed,并 break 落到收尾 —— 收尾恒发终点事件
                    // (这里是 response.failed,见下),避免 codex 报
                    // "stream closed before response.completed"(Windows 反馈)。
                    failed = Some(json!({"type": "upstream_error", "message": format!("upstream stream error: {e}")}));
                    break;
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

                        // 思考增量(deepseek 系 reasoning_content / 部分网关 reasoning)。
                        // Codex 只在带 summary_index 的 reasoning_summary_* 事件上取内容,
                        // 其余字段照 OpenAI 原生线形(空 summary 数组是硬要求)。
                        let think = delta
                            .get("reasoning_content")
                            .and_then(|v| v.as_str())
                            .or_else(|| delta.get("reasoning").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        if !think.is_empty() {
                            if reasoning_item.is_none() {
                                let item = json!({
                                    "type": "reasoning", "id": next_id("rs"),
                                    "status": "in_progress", "summary": []
                                });
                                reasoning_idx = next_index;
                                next_index += 1;
                                reasoning_item = Some(item.clone());
                                yield sse_event("response.output_item.added", json!({
                                    "type": "response.output_item.added", "output_index": reasoning_idx, "item": item
                                }));
                                yield sse_event("response.reasoning_summary_part.added", json!({
                                    "type": "response.reasoning_summary_part.added",
                                    "item_id": item["id"], "output_index": reasoning_idx, "summary_index": 0,
                                    "part": {"type": "summary_text", "text": ""}
                                }));
                            }
                            reasoning_buf.push_str(think);
                            yield sse_event("response.reasoning_summary_text.delta", json!({
                                "type": "response.reasoning_summary_text.delta",
                                "item_id": reasoning_item.as_ref().unwrap()["id"],
                                "output_index": reasoning_idx, "summary_index": 0, "delta": think
                            }));
                        }

                        // 正文增量:content + refusal(上游拒答文案)都按正文处理。
                        // Codex 的 ContentItem 没有 refusal 变体(只有 input/output_text
                        // 等),发 refusal part 会让整个 message item 反序列化失败被静默
                        // 丢弃;当正文带出去用户至少能看到拒答内容。
                        let mut chunk_text = String::new();
                        chunk_text.push_str(delta.get("content").and_then(|v| v.as_str()).unwrap_or(""));
                        chunk_text.push_str(delta.get("refusal").and_then(|v| v.as_str()).unwrap_or(""));
                        let text_delta = chunk_text.as_str();
                        let has_tools = delta
                            .get("tool_calls")
                            .and_then(|v| v.as_array())
                            .map(|a| !a.is_empty())
                            .unwrap_or(false);

                        // 其它内容到来时先关掉 reasoning item:OpenAI 原生流就是这个顺序,
                        // 客户端按该顺序挂载(参考实现同样如此)。
                        if reasoning_item.is_some() && (!text_delta.is_empty() || has_tools) {
                            let (evs, done) = close_reasoning(reasoning_item.take().unwrap(), reasoning_idx, &reasoning_buf);
                            for (ev, data) in evs {
                                yield sse_event(ev, data);
                            }
                            output_items.push((reasoning_idx, done));
                        }

                        if !text_delta.is_empty() {
                            if text_item.is_none() {
                                let item = json!({
                                    "type": "message", "id": next_id("msg"), "status": "in_progress",
                                    "role": "assistant", "content": []
                                });
                                text_idx = next_index;
                                next_index += 1;
                                text_item = Some(item.clone());
                                yield sse_event("response.output_item.added", json!({
                                    "type": "response.output_item.added", "output_index": text_idx,
                                    "item": item
                                }));
                                yield sse_event("response.content_part.added", json!({
                                    "type": "response.content_part.added", "item_id": item["id"], "output_index": text_idx,
                                    "content_index": 0,
                                    "part": {"type": "output_text", "text": "", "annotations": []}
                                }));
                            }
                            text_buf.push_str(text_delta);
                            yield sse_event("response.output_text.delta", json!({
                                "type": "response.output_text.delta", "item_id": text_item.as_ref().unwrap()["id"],
                                "output_index": text_idx, "content_index": 0, "delta": text_delta
                            }));
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
                                    tool_idx.insert(idx, next_index);
                                    next_index += 1;
                                    tool_args.insert(idx, String::new());
                                    yield sse_event("response.output_item.added", json!({
                                        "type": "response.output_item.added",
                                        "output_index": tool_idx[&idx],
                                        "item": item
                                    }));
                                }
                                if let Some(args) = tc.get("function").and_then(|v| v.get("arguments")).and_then(|v| v.as_str()) {
                                    tool_args.get_mut(&idx).map(|s| s.push_str(args));
                                    yield sse_event("response.function_call_arguments.delta", json!({
                                        "type": "response.function_call_arguments.delta",
                                        "item_id": tool_items[&idx]["id"],
                                        "output_index": tool_idx[&idx],
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

        // 上游一个字节都没发(首字节超时 / 空 200 流)时仍要先开 response.created:
        // Codex 按 created → … → 终点事件解析事件流,直接喂 failed 会被判成协议错误、
        // 把最有信息量的上游原因丢掉。
        if !started {
            yield sse_event("response.created", json!({
                "type": "response.created",
                "response": {"id": meta_id, "object": "response", "created_at": chrono_ts(), "status": "in_progress", "model": model, "output": []}
            }));
            yield sse_event("response.in_progress", json!({"type": "response.in_progress"}));
        }

        // 收尾:完成挂起 items
        if let Some(item) = reasoning_item.take() {
            let (evs, done) = close_reasoning(item, reasoning_idx, &reasoning_buf);
            for (ev, data) in evs {
                yield sse_event(ev, data);
            }
            output_items.push((reasoning_idx, done));
        }
        if let Some(mut item) = text_item.take() {
            item["status"] = json!("completed");
            item["content"] = json!([{"type": "output_text", "text": text_buf, "annotations": []}]);
            yield sse_event("response.content_part.done", json!({
                "type": "response.content_part.done", "item_id": item["id"], "output_index": text_idx, "content_index": 0
            }));
            yield sse_event("response.output_item.done", json!({"type": "response.output_item.done", "output_index": text_idx, "item": item}));
            output_items.push((text_idx, item));
        }
        let mut idxs: Vec<usize> = tool_items.keys().cloned().collect();
        idxs.sort_unstable();
        for idx in idxs {
            if let Some(mut item) = tool_items.remove(&idx) {
                item["status"] = json!("completed");
                item["arguments"] = json!(tool_args.remove(&idx).unwrap_or_default());
                yield sse_event("response.output_item.done", json!({
                    "type": "response.output_item.done", "output_index": tool_idx[&idx], "item": item
                }));
                output_items.push((tool_idx[&idx], item));
            }
        }
        // 终态 output 按 output_index 排序(首次出现顺序)
        output_items.sort_by_key(|(i, _)| *i);
        let output: Vec<Value> = output_items.into_iter().map(|(_, v)| v).collect();

        let mut resp = json!({
            "id": meta_id, "object": "response", "created_at": chrono_ts(), "status": "completed",
            "model": model, "output": output
        });
        // usage 恒用完整默认(缺失时补 input_tokens 等全字段):部分上游(如 grok/xAI)的
        // chat SSE 不返回 usage,若不补全,桌面端(内嵌 codex)解析 response.completed 会报
        // "missing field `input_tokens`"。
        resp["usage"] = chat_usage_to_responses(usage.as_ref());
        // 终点事件三选一(Codex 只解析事件类型,resp.status 鲜有消费):
        // - 上游流中断/带内错误 → response.failed:Codex 在该事件上读 error 并映射成
        //   可重试/上下文超限等类型;沿用 response.completed 会被静默当成正常空回答。
        // - finish_reason=length/content_filter → response.incomplete:Codex 在该事件上
        //   读 incomplete_details.reason 并向上抛错。
        // - 其余 → response.completed。
        let terminal = match failed.take() {
            Some(err) => {
                resp["status"] = json!("failed");
                resp["error"] = err;
                "response.failed"
            }
            None => match finish_status(finish_reason.as_deref()) {
                "incomplete" => {
                    resp["status"] = json!("incomplete");
                    if let Some(reason) = incomplete_reason(finish_reason.as_deref()) {
                        resp["incomplete_details"] = json!({"reason": reason});
                    }
                    "response.incomplete"
                }
                _ => "response.completed",
            },
        };
        yield sse_event(terminal, json!({"type": terminal, "response": resp}));
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

async fn post_upstream(
    st: &ProxyState,
    headers: &HeaderMap,
    target: &str,
    body: &Value,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut req = st.client.post(target).body(body.to_string());
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        if let Ok(v) = auth.to_str() {
            req = req.header(header::AUTHORIZATION, v);
        }
    }
    req = req
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream");
    req.send().await
}

/// 端点拒收 effort 档位时的重试体:剥掉外发请求里的 effort 参数。
/// convert 路径剥 chat 的顶层 reasoning_effort;透传路径剥 /responses 的
/// reasoning.effort(reasoning 只剩空对象时连键一起删,部分严格端点拒收空对象)。
/// 本来就没带 effort 时返回 None,调用方不必重试。
fn strip_effort_param(body: &Value, convert: bool) -> Option<Value> {
    let mut out = body.clone();
    let obj = out.as_object_mut()?;
    if convert {
        // tools×reasoning 互斥族:能带 tools 的请求只有 reasoning_effort="none" 一种形状
        // (实测省略即 400)。剥掉它正好落回那个 400 形状,重试只是白跑一次上游,
        // 所以这里不回 retry 体,让首个 400 的原始 body 直接透传给 Codex。
        if obj.contains_key("tools")
            && tools_effort_exclusive(body.get("model").and_then(|v| v.as_str()).unwrap_or(""))
        {
            return None;
        }
        if obj.remove("reasoning_effort").is_some() {
            return Some(out);
        }
        return None;
    }
    let reasoning = obj.get_mut("reasoning")?.as_object_mut()?;
    if reasoning.remove("effort").is_none() {
        return None;
    }
    if reasoning.is_empty() {
        obj.remove("reasoning");
    }
    Some(out)
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

    // 转换路径无状态、不保存响应:客户端若靠 previous_response_id 续写,静默忽略会变成
    // "丢上下文继续生成"的静默错误 —— 直接 400(透传路径由上游原生处理,不拦)。
    if convert {
        if let Some(prev) = body.get("previous_response_id").and_then(|v| v.as_str()) {
            if !prev.is_empty() {
                return json_err(
                    400,
                    "previous_response_id is not supported by this proxy (stateless): send the full conversation in `input`".to_string(),
                );
            }
        }
    }

    let (target, out_body) = if convert {
        (format!("{}/chat/completions", st.upstream_base_url.trim_end_matches('/')), responses_to_chat(&body))
    } else {
        (format!("{}/responses", st.upstream_base_url.trim_end_matches('/')), body.clone())
    };

    // 流式请求给上游「回响应头」设 deadline:网关挂起时(实测 30~60s 连状态码都不发)
    // 600s 总超时等于永久卡死。非流式不设 —— 大上下文模型的整段生成本来就可能几十秒。
    let sent = if stream_req {
        match tokio::time::timeout(STREAM_FIRST_BYTE_TIMEOUT, post_upstream(&st, &headers, &target, &out_body)).await {
            Ok(r) => r,
            Err(_) => {
                return json_err(
                    504,
                    format!("upstream returned no response headers within {}s (gateway hang)", STREAM_FIRST_BYTE_TIMEOUT.as_secs()),
                )
            }
        }
    } else {
        post_upstream(&st, &headers, &target, &out_body).await
    };
    let mut upstream = match sent {
        Ok(r) => r,
        Err(e) => return json_err(502, format!("upstream connect failed: {e}")),
    };
    let mut status = upstream.status();
    let mut content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // 端点拒收 effort 档位(400/422,如严格 chat 端点对非推理模型拒收
    // reasoning_effort 参数本身)时,剥掉 effort 参数重试一次:首次请求已干净
    // 失败(未生成任何内容),重试安全;再失败则走下方原样透传。
    if status == StatusCode::BAD_REQUEST || status == StatusCode::UNPROCESSABLE_ENTITY {
        if let Some(retry_body) = strip_effort_param(&out_body, convert) {
            if let Ok(r2) = post_upstream(&st, &headers, &target, &retry_body).await {
                upstream = r2;
                status = upstream.status();
                content_type = upstream
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
            }
        }
    }

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
    // 健康检查固定用 127.0.0.1(代理监听回环;不要用 localhost,Windows 下 localhost 可能解析
    // 到 ::1,而 ::1 绑定常失败(socket 10048),导致健康检查连不上 → 误报端口被占用 → 超时)
    let health_target = "127.0.0.1";
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
                if health_check("127.0.0.1", port) {
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
        assert!(should_convert("gpt-6-luna", DEFAULT_CONVERT_PATTERN));
        assert!(should_convert("GPT-6-LUNA", DEFAULT_CONVERT_PATTERN));
        // kimi-k2.8 / step-5-preview 原生 /responses 可用,不进转换名单
        assert!(!should_convert("kimi-k2.8", DEFAULT_CONVERT_PATTERN));
        assert!(!should_convert("step-5-preview", DEFAULT_CONVERT_PATTERN));
        // mimo-v2.6 命中既有的 MiMo 规则(大小写不敏感)
        assert!(should_convert("mimo-v2.6-pro", DEFAULT_CONVERT_PATTERN));
    }

    #[test]
    fn responses_to_chat_max_tokens_field_by_model() {
        let mk = |model: &str| {
            responses_to_chat(&json!({"model": model, "input": "hi", "max_output_tokens": 1000}))
        };
        // gpt-6 只收 max_completion_tokens(发 max_tokens 上游 400)
        let gpt6 = mk("gpt-6-luna");
        assert_eq!(gpt6["max_completion_tokens"], 1000);
        assert!(gpt6.get("max_tokens").is_none());
        let gpt5 = mk("gpt-5.6-luna");
        assert_eq!(gpt5["max_completion_tokens"], 1000);
        let o = mk("o4-mini");
        assert_eq!(o["max_completion_tokens"], 1000);
        let other = mk("kimi-k2.8");
        assert_eq!(other["max_tokens"], 1000);
        assert!(other.get("max_completion_tokens").is_none());
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
        // arguments 原样透传,不得双重编码(上游必须收到 {…} 而不是 "{…}")
        assert_eq!(msgs[0]["tool_calls"][0]["function"]["arguments"], "{\"cmd\":\"ls\"}");
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
    fn chat_conversion_forwards_effort_but_omits_none() {
        // high → 转发 reasoning_effort
        let high = json!({"model":"glm-5.3-flash","reasoning":{"effort":"high"},
            "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]});
        let c = responses_to_chat(&high);
        assert_eq!(c["reasoning_effort"], "high");
        // none → 不发送(避免 claude/gemini-3.7/grok 的 400)
        let none = json!({"model":"claude-sonnet-5","reasoning":{"effort":"none"},
            "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]});
        let c2 = responses_to_chat(&none);
        assert!(c2.get("reasoning_effort").is_none());
    }

    #[test]
    fn strip_effort_param_convert_path() {
        // convert 路径:剥顶层 reasoning_effort,其余保留
        let chat = json!({"model":"glm-5.3-flash","reasoning_effort":"max","messages":[]});
        let stripped = strip_effort_param(&chat, true).unwrap();
        assert!(stripped.get("reasoning_effort").is_none());
        assert_eq!(stripped["model"], "glm-5.3-flash");
        // 本来就没带 → None(不重试)
        assert!(strip_effort_param(&json!({"model":"x","messages":[]}), true).is_none());
    }

    #[test]
    fn strip_effort_param_passthrough_path() {
        // 透传路径:剥 reasoning.effort,reasoning 其他键保留
        let body = json!({"model":"x","reasoning":{"effort":"low","summary":"auto"},"input":[]});
        let s = strip_effort_param(&body, false).unwrap();
        assert!(s.pointer("/reasoning/effort").is_none());
        assert_eq!(s["reasoning"]["summary"], "auto");
        // reasoning 只剩 effort 时连键删(部分严格端点拒收空对象)
        let only_effort = json!({"model":"x","reasoning":{"effort":"high"}});
        let s2 = strip_effort_param(&only_effort, false).unwrap();
        assert!(s2.get("reasoning").is_none());
        // 无 reasoning / reasoning 无 effort → None
        assert!(strip_effort_param(&json!({"model":"x"}), false).is_none());
        assert!(strip_effort_param(&json!({"model":"x","reasoning":{"summary":"auto"}}), false).is_none());
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

    #[test]
    fn history_assistant_output_text_parts_survive() {
        // Codex 回放历史时 assistant 消息的 part 是 output_text(非 input_text),
        // 丢它 = 模型看不到自己上一轮说过什么。
        let body = json!({
            "model": "gpt-5.6-luna",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "prev answer"}]}
            ]
        });
        let chat = responses_to_chat(&body);
        let msgs = chat["messages"].as_array().unwrap();
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "prev answer");
    }

    #[test]
    fn parallel_function_calls_merge_into_one_assistant_message() {
        // 并行工具调用回放:连续 function_call item → 一条 assistant + N 个 tool_calls
        // (连续 assistant 回合会被严格上游拒收)。
        let body = json!({
            "model": "gpt-5.6-luna",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "go"}]},
                {"type": "function_call", "call_id": "c1", "name": "a", "arguments": "{}"},
                {"type": "function_call", "call_id": "c2", "name": "b", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "c1", "output": "1"},
                {"type": "function_call_output", "call_id": "c2", "output": "2"}
            ]
        });
        let chat = responses_to_chat(&body);
        let msgs = chat["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4); // user, assistant(2 tool_calls), tool, tool
        let calls = msgs[1]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "c1");
        assert_eq!(calls[0]["function"]["name"], "a");
        assert_eq!(calls[1]["id"], "c2");
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "c1");
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "c2");
    }

    #[test]
    fn namespaced_function_call_rejoins_flat_name_on_replay() {
        // 响应方向:chat 名 mcp__git__status → {name:"status", namespace:"mcp__git"}
        let chat = json!({
            "choices": [{
                "message": {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "mcp__git__status", "arguments": "{}"}}
                ]},
                "finish_reason": "tool_calls"
            }]
        });
        let resp = chat_to_responses_json(&chat, "gpt-5.6-sol");
        let item = &resp["output"][0];
        assert_eq!(item["name"], "status");
        assert_eq!(item["namespace"], "mcp__git");
        // 回放方向:Codex 原样带回 {name, namespace},必须拼回扁平名,否则上游无此工具
        let replay = responses_to_chat(&json!({
            "model": "gpt-5.6-sol",
            "input": [
                item.clone(),
                {"type": "function_call_output", "call_id": item["call_id"], "output": "ok"}
            ]
        }));
        let msgs = replay["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["tool_calls"][0]["function"]["name"], "mcp__git__status");
        assert_eq!(msgs[1]["role"], "tool");
    }

    #[tokio::test]
    async fn in_band_error_emits_response_failed() {
        // 网关以 HTTP 200 + {"error":...} 带内拒绝:终点事件必须是 response.failed,
        // Codex 才会按 error.code 呈现/重试(response.completed 的 status 它不解析)。
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"error\":{\"type\":\"upstream_error\",\"code\":\"rate_limit_exceeded\",\"message\":\"quota\"}}\n\n")),
        ];
        let s = transform_chat_sse(iter(chunks), "gpt-5.6-luna".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        assert!(text.contains("event: response.failed"));
        assert!(!text.contains("event: response.completed"));
        assert!(text.contains("\"status\":\"failed\""));
        assert!(text.contains("rate_limit_exceeded"));
    }

    #[tokio::test(start_paused = true)]
    async fn first_byte_timeout_emits_failed_after_created() {
        // 网关挂起(200 + 零字节)时必须以带内 response.failed 收场,而不是让 Codex
        // 干等到 600s 总超时;且 failed 之前要有 created(Codex 严格事件序)。
        let s = transform_chat_sse(futures_util::stream::pending(), "gpt-6-luna".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        assert!(text.contains("event: response.created"), "缺 created: {text}");
        assert!(text.contains("event: response.failed"));
        assert!(!text.contains("event: response.completed"));
        assert!(text.contains("upstream_timeout"));
    }

    #[test]
    fn gpt6_tools_force_reasoning_effort_none() {
        // 该族在 chat 路由上 tools×reasoning 互斥,且「省略」按非 none 默认处理 →
        // 带 tools(= Codex 的恒定形状)时只有显式 none 可用。
        // 工具用 Responses 扁平形(type/name/parameters),不是 chat 的嵌套 function 形。
        let with_tools = json!({
            "model": "gpt-6-luna",
            "input": [{"type": "message", "role": "user", "content": "hi"}],
            "tools": [{"type": "function", "name": "dummy", "parameters": {"type": "object"}}],
            "reasoning": {"effort": "high"}
        });
        assert_eq!(responses_to_chat(&with_tools)["tools"][0]["function"]["name"], "dummy");
        assert_eq!(responses_to_chat(&with_tools)["reasoning_effort"], "none");

        let no_effort = json!({
            "model": "gpt-6-luna",
            "input": "hi",
            "tools": [{"type": "function", "name": "dummy", "parameters": {"type": "object"}}]
        });
        assert_eq!(responses_to_chat(&no_effort)["reasoning_effort"], "none");

        // 不带 tools 时思考照常(该路由的限制只在带工具时生效)。
        let plain = json!({"model": "gpt-6-luna", "input": "hi", "reasoning": {"effort": "high"}});
        assert_eq!(responses_to_chat(&plain)["reasoning_effort"], "high");

        // 规则不外溢:gpt-5.6 带 tools 仍按用户选的档位转发(实测该路由可用)。
        let gpt56 = json!({
            "model": "gpt-5.6-luna",
            "input": "hi",
            "tools": [{"type": "function", "name": "dummy", "parameters": {"type": "object"}}],
            "reasoning": {"effort": "high"}
        });
        assert_eq!(responses_to_chat(&gpt56)["tools"][0]["function"]["name"], "dummy");
        assert_eq!(responses_to_chat(&gpt56)["reasoning_effort"], "high");
    }

    #[test]
    fn strip_effort_retry_skipped_for_exclusive_tools() {
        // 互斥族带 tools:剥掉 reasoning_effort 正好落回 400 形状,不该再白跑一次上游。
        let bad = json!({"model": "gpt-6-luna", "tools": [{"type": "function", "function": {"name": "d"}}], "reasoning_effort": "none", "messages": []});
        assert!(strip_effort_param(&bad, true).is_none());
        // 其它模型维持原行为:能剥就剥一次。
        let ok = json!({"model": "gpt-5.6-luna", "tools": [{"type": "function", "function": {"name": "d"}}], "reasoning_effort": "max", "messages": []});
        assert!(strip_effort_param(&ok, true).is_some());
        assert!(strip_effort_param(&ok, true).unwrap().get("reasoning_effort").is_none());
    }

    /// 把 SSE 文本解析成事件 JSON 列表(serde_json::Value 键按字典序序列化,
    /// 故不用脆弱的键序字符串断言)。
    fn parse_sse_events(text: &str) -> Vec<Value> {
        text.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter_map(|d| serde_json::from_str::<Value>(d).ok())
            .collect()
    }

    #[test]
    fn structured_output_format_maps_to_chat() {
        // Codex 的 text.format:扁平 json_schema(name 可缺省)
        let body = json!({
            "model": "gpt-5.6-luna",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "text": {"format": {"type": "json_schema", "name": "out", "strict": true, "schema": {"type": "object"}}}
        });
        let chat = responses_to_chat(&body);
        assert_eq!(chat["response_format"]["type"], "json_schema");
        assert_eq!(chat["response_format"]["json_schema"]["name"], "out");
        assert_eq!(chat["response_format"]["json_schema"]["strict"], true);
        assert_eq!(chat["response_format"]["json_schema"]["schema"]["type"], "object");
        // name 缺失 → 补默认(chat 校验 name 非空)
        let unnamed = json!({
            "model": "gpt-5.6-luna",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "text": {"format": {"type": "json_schema", "schema": {"type": "object"}}}
        });
        assert_eq!(
            responses_to_chat(&unnamed)["response_format"]["json_schema"]["name"],
            "final_output"
        );
        // 嵌套形(chat 回显)也接受
        let nested = json!({
            "model": "m",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "n", "schema": {"type": "object"}}}
        });
        assert_eq!(responses_to_chat(&nested)["response_format"]["json_schema"]["name"], "n");
        // json_object 两边同构,原样带
        let jo = json!({"model": "m", "response_format": {"type": "json_object"}});
        assert_eq!(responses_to_chat(&jo)["response_format"]["type"], "json_object");
        // 缺 schema / 未知类型 → 不映射(不发畸形参数给上游)
        let no_schema = json!({"model": "m", "text": {"format": {"type": "json_schema"}}});
        assert!(responses_to_chat(&no_schema).get("response_format").is_none());
        let unknown = json!({"model": "m", "text": {"format": {"type": "future_thing"}}});
        assert!(responses_to_chat(&unknown).get("response_format").is_none());
    }

    #[tokio::test]
    async fn reasoning_stream_emits_summary_events_before_message() {
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think \"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hard\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")),
            Ok(Bytes::from("data: [DONE]\n\n")),
        ];
        let s = transform_chat_sse(iter(chunks), "deepseek-v4-flash".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        let evs = parse_sse_events(&text);
        let kinds: Vec<&str> = evs.iter().filter_map(|e| e["type"].as_str()).collect();
        for want in [
            "response.reasoning_summary_part.added",
            "response.reasoning_summary_text.delta",
            "response.reasoning_summary_text.done",
            "response.reasoning_summary_part.done",
        ] {
            assert!(kinds.contains(&want), "missing {want}: {kinds:?}");
        }
        // added 时 summary 必须是空数组(Codex 拿不到该键会丢整个 item)
        let rs_added = evs
            .iter()
            .find(|e| e["type"] == "response.output_item.added" && e["item"]["type"] == "reasoning")
            .unwrap();
        assert_eq!(rs_added["item"]["summary"].as_array().unwrap().len(), 0);
        assert_eq!(rs_added["output_index"], 0);
        // summary_index 必带(Codex 无该键时静默丢弃 delta)
        let delta = evs
            .iter()
            .find(|e| e["type"] == "response.reasoning_summary_text.delta")
            .unwrap();
        assert_eq!(delta["summary_index"], 0);
        assert_eq!(delta["delta"], "think ");
        // reasoning 先关后开 message
        let rs_done = evs
            .iter()
            .position(|e| e["type"] == "response.reasoning_summary_text.done")
            .unwrap();
        let msg_added = evs
            .iter()
            .position(|e| e["type"] == "response.output_item.added" && e["item"]["type"] == "message")
            .unwrap();
        assert!(rs_done < msg_added, "reasoning 必须先于 message 收尾");
        // 终态:reasoning item 聚合完整且在首位
        let completed = evs.iter().find(|e| e["type"] == "response.completed").unwrap();
        assert_eq!(completed["response"]["output"][0]["type"], "reasoning");
        assert_eq!(completed["response"]["output"][0]["summary"][0]["text"], "think hard");
        assert_eq!(completed["response"]["output"][1]["type"], "message");
    }

    #[tokio::test]
    async fn truncated_stream_emits_response_incomplete() {
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"content\":\"trunc\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n")),
            Ok(Bytes::from("data: [DONE]\n\n")),
        ];
        let s = transform_chat_sse(iter(chunks), "gpt-5.6-luna".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        let evs = parse_sse_events(&text);
        let inc = evs.iter().find(|e| e["type"] == "response.incomplete").unwrap();
        assert_eq!(inc["response"]["status"], "incomplete");
        assert_eq!(inc["response"]["incomplete_details"]["reason"], "max_output_tokens");
        assert!(evs.iter().all(|e| e["type"] != "response.completed"));
    }

    #[test]
    fn nonstream_truncation_reports_incomplete_details() {
        let chat = json!({
            "choices": [{"message": {"role": "assistant", "content": "x"}, "finish_reason": "length"}]
        });
        let r = chat_to_responses_json(&chat, "gpt-5.6-luna");
        assert_eq!(r["status"], "incomplete");
        assert_eq!(r["incomplete_details"]["reason"], "max_output_tokens");
    }

    #[test]
    fn nonstream_reasoning_content_becomes_item() {
        let chat = json!({
            "choices": [{"message": {"role": "assistant", "content": "ans", "reasoning_content": "because"}, "finish_reason": "stop"}]
        });
        let r = chat_to_responses_json(&chat, "deepseek-v4-flash");
        assert_eq!(r["output"][0]["type"], "reasoning");
        assert_eq!(r["output"][0]["summary"][0]["text"], "because");
        assert_eq!(r["output"][1]["type"], "message");
    }

    #[test]
    fn tool_choice_forms_normalize_for_chat() {
        let chat = |v: Value| responses_to_chat(&json!({
            "model": "m",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "tool_choice": v
        }))["tool_choice"]
            .clone();
        assert_eq!(chat(json!("auto")), "auto");
        // 对象形 none 不得降级为 auto(那会重新打开被禁用的工具)
        assert_eq!(chat(json!({"type": "none"})), "none");
        assert_eq!(chat(json!({"type": "required"})), "required");
        assert_eq!(chat(json!({"type": "tool"})), "required");
        assert_eq!(chat(json!({"type": "any"})), "required");
        // Responses 扁平形 → chat 嵌套形
        assert_eq!(
            chat(json!({"type": "function", "name": "f"})),
            json!({"type": "function", "function": {"name": "f"}})
        );
        assert_eq!(
            chat(json!({"type": "function", "function": {"name": "g"}})),
            json!({"type": "function", "function": {"name": "g"}})
        );
        // function 无名 → required;未知字符串 → auto
        assert_eq!(chat(json!({"type": "function"})), "required");
        assert_eq!(chat(json!("whatever")), "auto");
    }

    #[test]
    fn tool_parameters_gain_object_type() {
        let body = json!({
            "model": "m",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "tools": [
                {"type": "function", "name": "no_params"},
                {"type": "function", "name": "loose", "parameters": {"properties": {"a": {"type": "string"}}}},
                {"type": "function", "name": "typed", "parameters": {"type": "object", "properties": {}}}
            ]
        });
        let tools = responses_to_chat(&body)["tools"].clone();
        assert_eq!(tools[0]["function"]["parameters"], json!({"type": "object"}));
        assert_eq!(tools[1]["function"]["parameters"]["type"], "object");
        assert!(tools[1]["function"]["parameters"]["properties"]["a"].is_object());
        assert_eq!(tools[2]["function"]["parameters"]["properties"], json!({}));
    }

    #[test]
    fn string_input_and_prompt_fallback() {
        // input 为纯字符串 → 单轮 user 消息
        let s = responses_to_chat(&json!({"model": "m", "input": "hello"}));
        let msgs = s["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "hello");
        // input 缺省时回退旧 prompt 字段
        let p = responses_to_chat(&json!({"model": "m", "prompt": "legacy"}));
        assert_eq!(p["messages"][0]["content"], "legacy");
    }

    #[test]
    fn instructions_dedup_only_on_identical_system_message() {
        // 同文 system 消息已在输入里 → 不重复前置
        let dup = responses_to_chat(&json!({
            "model": "m",
            "instructions": "be terse",
            "input": [
                {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "be terse"}]},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}
            ]
        }));
        let msgs = dup["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        // 不同文的 system 消息存在时,instructions 仍然前置(不能整个丢系统提示)
        let other = responses_to_chat(&json!({
            "model": "m",
            "instructions": "base prompt",
            "input": [
                {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "extra rules"}]},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}
            ]
        }));
        let msgs = other["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["content"], "base prompt");
        assert_eq!(msgs[1]["role"], "system"); // developer 归一
    }

    #[test]
    fn tool_output_parts_convert_to_chat_parts() {
        let body = json!({
            "model": "m",
            "input": [
                {"type": "function_call", "call_id": "c1", "name": "f", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "c1", "output": [
                    {"type": "output_text", "text": "{\"ok\":"},
                    {"type": "output_text", "text": "true}"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AAA"}
                ]}
            ]
        });
        let chat = responses_to_chat(&body);
        let content = &chat["messages"][1]["content"];
        assert_eq!(content[0], json!({"type": "text", "text": "{\"ok\":"}));
        assert_eq!(content[1], json!({"type": "text", "text": "true}"}));
        assert_eq!(content[2]["type"], "image_url");
        assert_eq!(content[2]["image_url"]["url"], "data:image/png;base64,AAA");
    }

    #[test]
    fn parallel_tool_calls_and_user_forwarded() {
        let chat = responses_to_chat(&json!({
            "model": "m",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}],
            "parallel_tool_calls": false,
            "user": "u-1"
        }));
        assert_eq!(chat["parallel_tool_calls"], false);
        assert_eq!(chat["user"], "u-1");
    }

    #[tokio::test]
    async fn refusal_streams_as_text_and_finishes_incomplete() {
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"refusal\":\"I can't\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"refusal\"}]}\n\n")),
            Ok(Bytes::from("data: [DONE]\n\n")),
        ];
        let s = transform_chat_sse(iter(chunks), "gpt-5.6-luna".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        let evs = parse_sse_events(&text);
        // 拒答以 output_text.delta 流给 Codex(无 refusal part:Codex 无该变体)
        let delta = evs
            .iter()
            .find(|e| e["type"] == "response.output_text.delta")
            .unwrap();
        assert_eq!(delta["delta"], "I can't");
        let inc = evs.iter().find(|e| e["type"] == "response.incomplete").unwrap();
        assert_eq!(inc["response"]["status"], "incomplete");
        assert!(inc["response"].get("incomplete_details").is_none());
        assert_eq!(inc["response"]["output"][0]["content"][0]["text"], "I can't");
        assert!(evs.iter().all(|e| e["type"] != "response.completed"));
    }

    #[test]
    fn nonstream_refusal_merges_into_text() {
        let chat = json!({
            "choices": [{"message": {"role": "assistant", "content": null, "refusal": "policy"}, "finish_reason": "refusal"}]
        });
        let r = chat_to_responses_json(&chat, "gpt-5.6-luna");
        assert_eq!(r["status"], "incomplete");
        assert_eq!(r["output"][0]["content"][0]["type"], "output_text");
        assert_eq!(r["output"][0]["content"][0]["text"], "policy");
    }

    #[tokio::test]
    async fn output_indices_align_after_text_then_tool() {
        // 先文本后工具:文本 item 占 0,function_call 必须是 1,added 与 done 一致
        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n")),
            Ok(Bytes::from("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c0\",\"type\":\"function\",\"function\":{\"name\":\"exec\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n")),
            Ok(Bytes::from("data: [DONE]\n\n")),
        ];
        let s = transform_chat_sse(iter(chunks), "gpt-5.6-sol".to_string());
        let out = futures_util::StreamExt::collect::<Vec<_>>(Box::pin(s)).await;
        let text = out
            .into_iter()
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .collect::<Vec<_>>()
            .join("");
        let evs = parse_sse_events(&text);
        let idx = |ev_type: &str, item_type: &str|
            evs.iter()
                .find(|e| e["type"] == ev_type && e["item"]["type"] == item_type)
                .unwrap()["output_index"]
                .clone();
        assert_eq!(idx("response.output_item.added", "message"), 0);
        assert_eq!(idx("response.output_item.added", "function_call"), 1);
        assert_eq!(idx("response.output_item.done", "function_call"), 1);
        let completed = evs.iter().find(|e| e["type"] == "response.completed").unwrap();
        assert_eq!(completed["response"]["output"][0]["type"], "message");
        assert_eq!(completed["response"]["output"][1]["type"], "function_call");
    }
}