import { describe, expect, it } from 'vitest'
import { CardboardPoseTracker } from './cardboardPoseTracker'
import {
  deviceOrientationQuaternion,
  quaternionAngularDistanceDegrees,
  viewQuaternion,
  type Quaternion,
} from './stereoPanoramaMath'

function expectSamePose(actual: Quaternion, expected: Quaternion, precision = 5) {
  expect(quaternionAngularDistanceDegrees(actual, expected)).toBeCloseTo(0, precision)
}

describe('CardboardPoseTracker', () => {
  it('preserves the scene view on its first sensor sample', () => {
    const sceneView = viewQuaternion(24, -8)
    const tracker = new CardboardPoseTracker(sceneView)

    tracker.sample(deviceOrientationQuaternion(12, 80, -4, 0), 0, 10, 10)

    expectSamePose(tracker.getPose(), sceneView)
    expect(tracker.getState()).toBe('active')
  })

  it('rebases without a jump when Android settles from portrait to landscape', () => {
    const tracker = new CardboardPoseTracker(viewQuaternion(17, -5))
    tracker.sample(deviceOrientationQuaternion(12, 80, -4, 0), 0, 10, 10)
    const beforeRotation = tracker.getPose()

    tracker.sample(deviceOrientationQuaternion(12, 80, -4, 90), 90, 26, 26)

    expectSamePose(tracker.getPose(), beforeRotation)
    tracker.sample(deviceOrientationQuaternion(22, 80, -4, 90), 90, 42, 42)
    expect(quaternionAngularDistanceDegrees(tracker.getPose(), beforeRotation)).toBeGreaterThan(4)
  })

  it('holds sensor noise inside the headset dead band', () => {
    const tracker = new CardboardPoseTracker(viewQuaternion(0, 0))
    tracker.sample(viewQuaternion(0, 0), 0, 0, 0)
    const steady = tracker.getPose()

    tracker.sample(viewQuaternion(0.05, 0), 0, 16, 16)

    expectSamePose(tracker.getPose(), steady)
  })

  it('responds quickly to an intentional head turn', () => {
    const tracker = new CardboardPoseTracker(viewQuaternion(0, 0))
    tracker.sample(viewQuaternion(0, 0), 0, 0, 0)
    const target = viewQuaternion(10, 0)

    tracker.sample(target, 0, 16, 16)

    expect(quaternionAngularDistanceDegrees(tracker.getPose(), target)).toBeLessThan(2)
  })

  it('holds a stale pose, permits drag, and recovers without snapping', () => {
    const tracker = new CardboardPoseTracker(viewQuaternion(0, 0))
    tracker.sample(viewQuaternion(0, 0), 0, 0, 0)
    tracker.sample(viewQuaternion(8, 0), 0, 16, 16)
    const lastSensorPose = tracker.getPose()

    expect(tracker.updateStaleness(1300)).toBe(true)
    expectSamePose(tracker.getPose(), lastSensorPose)
    tracker.applyManualDelta(5, 0)
    const draggedPose = tracker.getPose()

    tracker.sample(viewQuaternion(20, 0), 0, 1400, 1400)
    expectSamePose(tracker.getPose(), draggedPose)
    tracker.sample(viewQuaternion(25, 0), 0, 1416, 1416)
    expect(quaternionAngularDistanceDegrees(tracker.getPose(), draggedPose)).toBeGreaterThan(2)
  })

  it('ignores non-finite sensor samples', () => {
    const tracker = new CardboardPoseTracker(viewQuaternion(0, 0))

    expect(tracker.sample([Number.NaN, 0, 0, 1], 0, 0, 0)).toBeNull()
    expect(tracker.getState()).toBe('waiting')
  })

  it('keeps repeated vertical drag upright', () => {
    const tracker = new CardboardPoseTracker(viewQuaternion(0, 0))

    for (let step = 0; step < 30; step += 1) {
      tracker.applyManualDelta(0, 10)
    }

    expect(quaternionAngularDistanceDegrees(
      tracker.getPose(),
      viewQuaternion(0, 85),
    )).toBeLessThan(0.01)
  })
})
