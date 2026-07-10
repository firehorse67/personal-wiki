// Shared voice capture: record via MediaRecorder, transcribe via Gemini's
// audio input. Used by the dashboard Quick Post widget and (soon) the
// TipTap toolbar — one recorder, one transcription call, two mount points.

const PREFERRED_MIME_TYPES = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/mp4',
	'audio/ogg;codecs=opus'
];

function pickMimeType(): string {
	for (const type of PREFERRED_MIME_TYPES) {
		if (MediaRecorder.isTypeSupported(type)) return type;
	}
	return ''; // let the browser choose
}

export interface VoiceRecording {
	blob: Blob;
	mimeType: string;
	durationMs: number;
}

export interface RecordingController {
	stop: () => Promise<VoiceRecording>;
	cancel: () => void;
}

/** Requests mic access and starts recording immediately. */
export async function startRecording(): Promise<RecordingController> {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	const mimeType = pickMimeType();
	const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
	const chunks: BlobPart[] = [];
	const startedAt = Date.now();

	recorder.addEventListener('dataavailable', (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	});

	recorder.start();

	function teardown() {
		for (const track of stream.getTracks()) track.stop();
	}

	return {
		stop: () =>
			new Promise<VoiceRecording>((resolve, reject) => {
				recorder.addEventListener(
					'stop',
					() => {
						teardown();
						if (chunks.length === 0) {
							reject(new Error('No audio captured'));
							return;
						}
						resolve({
							blob: new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }),
							mimeType: recorder.mimeType || mimeType || 'audio/webm',
							durationMs: Date.now() - startedAt
						});
					},
					{ once: true }
				);
				recorder.stop();
			}),
		cancel: () => {
			if (recorder.state !== 'inactive') recorder.stop();
			teardown();
		}
	};
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/**
 * Sends the recording to Gemini for verbatim transcription. Requires the
 * user's own Gemini API key (Settings → AI Integration) — same key the
 * chat assistant uses, so no separate configuration.
 */
export async function transcribeAudio(recording: VoiceRecording, apiKey: string): Promise<string> {
	if (!apiKey) throw new Error('Add a Gemini API key in Settings → AI Integration first');

	const data = await blobToBase64(recording.blob);
	const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			contents: [
				{
					role: 'user',
					parts: [
						{ text: 'Transcribe this audio verbatim. Return only the transcript text, no commentary.' },
						{ inlineData: { mimeType: recording.mimeType, data } }
					]
				}
			]
		})
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(body || `Transcription failed (${response.status})`);
	}
	const json = await response.json();
	const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!text) throw new Error('No transcript returned');
	return text.trim();
}

/** File extension matching a recorder mime type, for upload naming. */
export function extensionFor(mimeType: string): string {
	if (mimeType.includes('webm')) return 'webm';
	if (mimeType.includes('mp4')) return 'm4a';
	if (mimeType.includes('ogg')) return 'ogg';
	return 'webm';
}
