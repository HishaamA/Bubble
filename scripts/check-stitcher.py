"""Exercise the real HTTP stitcher with 34 reproducible, pose-perturbed views.

This uses the bundled concept panorama, not private family photos. It measures
reconstruction of a known scene, not a claim about untested handheld captures.
Generated photos/results stay under ignored private-media/stitch-check.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import time

import cv2
import httpx
import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def generate(directory: Path, unposed: bool) -> dict:
    texture = cv2.imread(str(ROOT / 'public/assets/panoramas/sunday-dinner-demo.jpg'))
    if texture is None:
        raise RuntimeError('The bundled concept panorama was not found.')
    directory.mkdir(parents=True, exist_ok=True)
    targets = [(0, 82)]
    for pitch, count, offset in [(55, 5, 36), (27, 7, 0), (0, 8, 22.5),
                                  (-27, 7, 360 / 14), (-55, 5, 0)]:
        targets.extend((offset + i * 360 / count, pitch) for i in range(count))
    targets.append((0, -82))
    width, height = 512, 684
    focal = width / (2 * math.tan(math.radians(62 / 2)))
    x, y = np.meshgrid(np.arange(width), np.arange(height))
    sx, sy = (x - (width - 1) / 2) / focal, -(y - (height - 1) / 2) / focal
    frames = []
    for index, (yaw_deg, pitch_deg) in enumerate(targets):
        yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
        forward = np.array([math.cos(pitch) * math.sin(yaw), math.sin(pitch),
                            math.cos(pitch) * math.cos(yaw)])
        right = np.array([math.cos(yaw), 0, -math.sin(yaw)])
        up = np.array([-math.sin(pitch) * math.sin(yaw), math.cos(pitch),
                       -math.sin(pitch) * math.cos(yaw)])
        rays = forward + sx[..., None] * right + sy[..., None] * up
        rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
        map_x = ((np.arctan2(rays[..., 0], rays[..., 2]) / (2 * math.pi) + 0.5)
                 * texture.shape[1]).astype(np.float32)
        map_y = ((0.5 - np.arcsin(rays[..., 1]) / math.pi)
                 * texture.shape[0]).astype(np.float32)
        photo = cv2.remap(texture, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)
        photo = np.clip(photo.astype(np.float32) * (1 + 0.07 * math.sin(index)), 0, 255).astype(np.uint8)
        file_name = f'frame-{index:03d}.jpg'
        cv2.imwrite(str(directory / file_name), photo, [cv2.IMWRITE_JPEG_QUALITY, 96])
        metadata = {'fileName': file_name, 'width': width, 'height': height}
        if not unposed:
            # Exact calibration, imperfect pose, as with drift in a native scan.
            metadata.update({
                'yawDegrees': yaw_deg + (0 if index == 0 else 1.5 * math.sin(index * 1.31)),
                'pitchDegrees': pitch_deg + (0 if index == 0 else 1.1 * math.cos(index * 1.73)),
                'rollDegrees': 0,
                'intrinsics': [focal, 0, (width - 1) / 2, 0, focal, (height - 1) / 2, 0, 0, 1],
            })
        frames.append(metadata)
    manifest = {'version': 1, 'outputWidth': 4096, 'frames': frames}
    if unposed:
        manifest['projection'] = 'unposed'
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5173/api/stitch')
    parser.add_argument('--generate-only', action='store_true')
    parser.add_argument('--unposed', action='store_true')
    args = parser.parse_args()
    directory = ROOT / 'private-media/stitch-check' / ('unposed' if args.unposed else 'posed')
    manifest = generate(directory, args.unposed)
    if args.generate_only:
        print(directory)
        return
    with httpx.Client(timeout=180) as client:
        health = client.get(args.url + '/health')
        health.raise_for_status()
        print('Health:', health.json(), flush=True)
        if not health.json().get('aiAvailable'):
            raise RuntimeError('The real learned matcher must be loaded for this check.')
        files = [('frames', (frame['fileName'], (directory / frame['fileName']).read_bytes(), 'image/jpeg'))
                 for frame in manifest['frames']]
        started = time.monotonic()
        response = client.post(args.url + '/jobs', data={'manifest': json.dumps(manifest)}, files=files)
        response.raise_for_status()
        job_url = args.url + '/jobs/' + response.json()['id']
        previous = None
        try:
            while time.monotonic() - started < 1800:
                result = client.get(job_url)
                result.raise_for_status()
                job = result.json()
                stage = (job['status'], job['phase'], job['completed'], job['total'])
                if stage != previous:
                    print(stage, flush=True)
                    previous = stage
                if job['status'] in ('failed', 'cancelled'):
                    raise RuntimeError(job.get('error', job['status']))
                if job['status'] == 'completed':
                    print(json.dumps(job.get('report'), indent=2), flush=True)
                    (directory / 'report.json').write_text(json.dumps(job, indent=2), encoding='utf-8')
                    for name in ('panorama', 'thumbnail'):
                        image = client.get(job_url + '/' + name)
                        image.raise_for_status()
                        (directory / (name + '.jpg')).write_bytes(image.content)
                    panorama = cv2.imread(str(directory / 'panorama.jpg'))
                    assert panorama.shape[:2] == (2048, 4096), panorama.shape
                    assert job['report']['aiUsed'], 'The learned model was not used.'
                    print(f'PASS: actual learned stitch, 4096x2048, {time.monotonic() - started:.1f}s. {directory}')
                    return
                time.sleep(1)
            raise TimeoutError('Benchmark did not complete within 30 minutes.')
        finally:
            client.delete(job_url)


if __name__ == '__main__':
    main()
