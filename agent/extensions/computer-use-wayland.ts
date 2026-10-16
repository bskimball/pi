// Cua's bundled driver inherits Pi's environment but defaults to XWayland.
export default function (): void {
  if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
    process.env.CUA_DRIVER_RS_ENABLE_WAYLAND ??= "1";
  }
}
