// How each engine is started for the voice prototype (P4C.1): fake capture
// devices where the engine has them, and audio that starts without a gesture.
//
// Chromium's fake microphone did not work on the Mac this was written on
// (Playwright 1.65.1's Chromium, macOS 27): `getUserMedia` never settles with
// `--use-fake-ui-for-media-stream`, in the headless shell or the full browser,
// and without that switch a granted permission gets `NotSupportedError`. So a
// Chromium person sends a Web Audio tone, which takes the same road from the
// Opus encoder on, and voice.proto.ts skips Chromium's capture check there.
import type { LaunchOptions } from '@playwright/test';

export const ORIGIN = 'http://127.0.0.1:4390';

export const launch: Record<'chromium' | 'firefox' | 'webkit', LaunchOptions> = {
	chromium: {
		args: [
			'--use-fake-device-for-media-stream',
			'--use-fake-ui-for-media-stream',
			'--autoplay-policy=no-user-gesture-required'
		]
	},
	firefox: {
		firefoxUserPrefs: {
			'media.navigator.streams.fake': true,
			'media.navigator.permission.disabled': true,
			'media.autoplay.default': 0,
			'media.autoplay.blocking_policy': 0
		}
	},
	// Playwright's WebKit has a mock microphone once a context is given the
	// permission (room.ts). Three limits of this build shape how it is tested:
	// it finishes gathering ICE candidates only on a page that has captured; an
	// AudioContext stops rendering about half a second after capture starts,
	// while still saying `running`; and only one page of a browser captures at a
	// time. So a WebKit person has a browser of their own, sends the mock
	// microphone, makes no AudioContext, and is judged by WebRTC's statistics.
	// Whether Safari itself shares any of these is for a real device to say (P4C.9).
	webkit: {}
};
