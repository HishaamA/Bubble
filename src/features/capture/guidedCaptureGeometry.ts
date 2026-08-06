export type GuideTarget = {
  id: string
  yaw: number
  pitch: number
}

function wrapAngle(value: number) {
  return ((value + 540) % 360) - 180
}

export function projectGuideTarget(
  target: GuideTarget,
  view: { yaw: number; pitch: number },
) {
  const deltaYaw = wrapAngle(target.yaw - view.yaw)
  const deltaPitch = target.pitch - view.pitch
  const visible = Math.abs(deltaYaw) < 72 && Math.abs(deltaPitch) < 58
  const centreDistance = Math.hypot(deltaYaw / 72, deltaPitch / 58)
  return {
    visible,
    left: 50 + (deltaYaw / 72) * 50,
    top: 50 - (deltaPitch / 58) * 50,
    scale: Math.max(0.58, 1.2 - centreDistance * 0.5),
    centreDistance,
  }
}
