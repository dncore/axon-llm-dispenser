// 开机自启:前端决策逻辑(纯函数,可测)。
// 注意:开关的真实状态由 OS 侧持有(macOS LaunchAgent / Windows 注册表),
// 前端只负责查询回填与调用 enable/disable,不做本地持久化。

/**
 * 切换失败后应回滚到的开关状态。
 * 优先查询系统侧真实状态(切换失败说明系统状态未按用户操作变化);
 * 查询也失败(如平台不支持)时维持用户请求值,避免体验上「点了没反应」。
 */
export async function fallbackAutostartChecked(
  requestedChecked: boolean,
  queryEnabled: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await queryEnabled();
  } catch {
    return requestedChecked;
  }
}
