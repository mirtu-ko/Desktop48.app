export const STREAM_SERVER_HOST = '127.0.0.1'
export const STREAM_SERVER_MIN_PORT = 8080
export const STREAM_SERVER_MAX_PORT = 8090

let serverPort = STREAM_SERVER_MIN_PORT
let serverUnavailableReason: string | null = null

export function getStreamServerPort(): number {
  return serverPort
}

export function setStreamServerPort(port: number): void {
  serverPort = port
  serverUnavailableReason = null
}

export function setStreamServerExhausted(exhausted: boolean): void {
  serverUnavailableReason = exhausted
    ? `本地流媒体服务启动失败（端口 ${STREAM_SERVER_MIN_PORT}-${STREAM_SERVER_MAX_PORT} 均被占用），请关闭占用端口的应用后重启本应用`
    : null
}

export function setStreamServerUnavailable(reason: string): void {
  serverUnavailableReason = reason
}

/** 停服或测试时复位端口与不可用状态 */
export function resetStreamServerState(): void {
  serverPort = STREAM_SERVER_MIN_PORT
  serverUnavailableReason = null
}

/** 本地流媒体服务是否可用；启动失败或端口耗尽时抛出用户可读的错误（经 IPC 回传渲染层弹窗） */
export function assertLocalServerAvailable(): void {
  if (serverUnavailableReason)
    throw new Error(serverUnavailableReason)
}
