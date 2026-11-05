import { startRecording, type Recording } from "./capture";
import { transcribe, type Transcription } from "./api";

/** Injectable only at the application boundary; production always uses native transport. */
export interface DictationApi {
  start(consent: boolean, signal: AbortSignal): Promise<Recording>;
  transcribe(
    bytes: Uint8Array,
    scope: string,
    consent: boolean,
    signal: AbortSignal,
  ): Promise<Transcription>;
}
export const dictationApi: DictationApi = { start: startRecording, transcribe };
