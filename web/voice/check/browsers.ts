// How each engine is started for voice checks in Playwright: fake capture
// devices where the engine has them, and audio that starts without a gesture.
// docs/voice.md (Testing) has what each engine can and cannot do.
import type { LaunchOptions } from '@playwright/test';

export const launch: Record<'chromium' | 'firefox' | 'webkit', LaunchOptions> = {
	// Chromium's fake microphone works on Linux. On macOS `getUserMedia` never
	// settles with these switches (Playwright 1.65.1's Chromium, macOS 27), in
	// the headless shell or the full browser, so a Chromium person there sends a
	// Web Audio tone, which takes the same road from the Opus encoder on.
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
	// permission. Three limits of the macOS build shape how it is tested: it
	// finishes gathering ICE candidates only on a page that has captured; an
	// AudioContext stops rendering about half a second after capture starts,
	// while still saying `running`; and only one page of a browser captures at a
	// time. So a WebKit person has a browser of their own, sends the mock
	// microphone, makes no AudioContext, and is judged by WebRTC's statistics.
	// Whether Safari itself shares any of these is for a real device to say (P4C.9).
	// Playwright's WebKit for Linux is another WebRTC build, with no
	// `RTCRtpScriptTransform` at all (`canTransform`).
	webkit: {}
};

// Firefox takes no part in Web Audio on a machine with no sound device, as a
// CI runner is: `AudioContext.resume()` never settles there. Its fake
// microphone needs none, so a Firefox person captures and is judged by
// WebRTC's statistics too.

// Whether an engine's fake microphone can be used on this machine.
export const canCapture = (engine: string): boolean =>
	engine !== 'chromium' || process.platform !== 'darwin';

// Whether an engine can run a worker on encoded frames on this machine.
export const canTransform = (engine: string): boolean =>
	engine !== 'webkit' || process.platform !== 'linux';
