//! Native microphone capture and the one canonical, bounded WAV format accepted for dictation.
//! Samples never touch the file store, database, exports or backups.
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use zeroize::Zeroize;

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_MS: u64 = 120_000;

pub fn id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Couldn't create a recording ID.")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Strict canonical mono PCM16: no filenames, paths, metadata chunks or ambiguous durations.
pub fn wav_duration(bytes: &[u8]) -> Result<u64, String> {
    let invalid = || "Invalid recording. Record mono PCM16 WAV audio again.".to_string();
    if bytes.len() < 46 || bytes.len() > MAX_BYTES {
        return Err("Recordings must contain audio and fit within 20 MiB.".into());
    }
    let u32_at = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    let u16_at = |i| u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap());
    let rate = u32_at(24);
    if &bytes[..4] != b"RIFF"
        || &bytes[8..16] != b"WAVEfmt "
        || &bytes[36..40] != b"data"
        || u32_at(4) as usize != bytes.len() - 8
        || u32_at(16) != 16
        || u16_at(20) != 1
        || u16_at(22) != 1
        || !(8_000..=96_000).contains(&rate)
        || u32_at(28) != rate * 2
        || u16_at(32) != 2
        || u16_at(34) != 16
        || u32_at(40) as usize != bytes.len() - 44
        || !(bytes.len() - 44).is_multiple_of(2)
    {
        return Err(invalid());
    }
    let ms = (((bytes.len() - 44) / 2) as u64 * 1000).div_ceil(u64::from(rate));
    if ms > MAX_MS {
        return Err("Recordings are limited to two minutes.".into());
    }
    Ok(ms)
}

pub fn wav(samples: &[i16], rate: u32) -> Result<Vec<u8>, String> {
    if samples.len() > (MAX_BYTES - 44) / 2 {
        return Err("Recording exceeds 20 MiB.".into());
    }
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate.saturating_mul(2)).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    wav_duration(&out)?;
    Ok(out)
}

#[derive(Default)]
struct Buffer {
    samples: Vec<i16>,
    rate: u32,
    ready: bool,
    error: Option<&'static str>,
}
impl Drop for Buffer {
    fn drop(&mut self) {
        self.samples.zeroize();
    }
}
impl Buffer {
    fn append<T: cpal::Sample>(&mut self, input: &[T], channels: usize)
    where
        f32: cpal::FromSample<T>,
    {
        if self.ready || self.error.is_some() || channels == 0 {
            return;
        }
        let max = (self.rate as usize * 120).min((MAX_BYTES - 44) / 2);
        for frame in input.chunks_exact(channels) {
            if self.samples.len() == max {
                self.ready = true;
                break;
            }
            let value = frame.iter().map(|x| x.to_sample::<f32>()).sum::<f32>() / channels as f32;
            self.samples.push(if value.is_finite() {
                (value.clamp(-1.0, 1.0) * 32767.0).round() as i16
            } else {
                0
            });
        }
        if self.samples.len() == max {
            self.ready = true;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    id: String,
    phase: &'static str,
    duration_ms: u64,
    bytes: usize,
    error: Option<&'static str>,
}
enum Control {
    Stop,
    Cancel,
}
struct Session {
    id: String,
    control: mpsc::Sender<Control>,
    buffer: Arc<Mutex<Buffer>>,
    worker: std::thread::JoinHandle<Result<Vec<u8>, String>>,
}
/// The CPAL stream remains on its own thread, including platforms where it cannot be sent.
#[derive(Clone, Default)]
pub struct Audio(Arc<Mutex<Option<Session>>>);

fn input_stream<T: cpal::SizedSample>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    buffer: Arc<Mutex<Buffer>>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let channels = usize::from(config.channels);
    let errors = buffer.clone();
    device.build_input_stream(config, move |data: &[T], _| {
        if let Ok(mut b) = buffer.lock() { b.append(data, channels); }
    }, move |_| { if let Ok(mut b) = errors.lock() { b.error = Some("Microphone disconnected or permission was revoked."); } }, Some(Duration::from_secs(2)))
        .map_err(|_| "Couldn't open the microphone. Check OS microphone permissions and the default input device.".into())
}

fn record(
    buffer: Arc<Mutex<Buffer>>,
    control: mpsc::Receiver<Control>,
    opened: mpsc::Sender<Result<(), String>>,
) -> Result<Vec<u8>, String> {
    let stream: Result<cpal::Stream, String> = (|| {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or("No default microphone is available.")?;
        let config = device
            .default_input_config()
            .map_err(|_| "Microphone unavailable. Check its connection and OS permissions.")?;
        if !(8_000..=96_000).contains(&config.sample_rate())
            || config.channels() == 0
            || config.channels() > 32
        {
            return Err("Choose a system microphone using an 8–96 kHz input format.".into());
        }
        buffer
            .lock()
            .map_err(|_| "Recording state unavailable.")?
            .rate = config.sample_rate();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => input_stream::<f32>(&device, config.into(), buffer.clone()),
            cpal::SampleFormat::F64 => input_stream::<f64>(&device, config.into(), buffer.clone()),
            cpal::SampleFormat::I16 => input_stream::<i16>(&device, config.into(), buffer.clone()),
            cpal::SampleFormat::U16 => input_stream::<u16>(&device, config.into(), buffer.clone()),
            cpal::SampleFormat::I32 => input_stream::<i32>(&device, config.into(), buffer.clone()),
            _ => Err(
                "This microphone's sample format isn't supported. Choose another system input."
                    .into(),
            ),
        }?;
        stream
            .play()
            .map_err(|_| "Couldn't start the microphone. Check OS microphone permissions.")?;
        Ok(stream)
    })();
    let stream = match stream {
        Ok(s) => {
            let _ = opened.send(Ok(()));
            s
        }
        Err(e) => {
            let _ = opened.send(Err(e.clone()));
            return Err(e);
        }
    };
    let started = Instant::now();
    let mut stream = Some(stream);
    let mut stopped_at = None;
    loop {
        match control.recv_timeout(Duration::from_millis(25)) {
            Ok(Control::Stop) => {
                drop(stream.take());
                let b = buffer.lock().map_err(|_| "Recording state unavailable.")?;
                if let Some(error) = b.error {
                    return Err(error.into());
                }
                return wav(&b.samples, b.rate);
            }
            Ok(Control::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Recording cancelled.".into());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let finished = {
            let mut b = buffer.lock().map_err(|_| "Recording state unavailable.")?;
            if started.elapsed() >= Duration::from_millis(MAX_MS) {
                b.ready = true;
            }
            b.ready || b.error.is_some()
        };
        if finished && stream.is_some() {
            drop(stream.take());
            stopped_at = Some(Instant::now());
        }
        // A lost webview cannot keep a microphone or its completed recording alive indefinitely.
        if stopped_at.is_some_and(|at| at.elapsed() >= Duration::from_secs(30)) {
            return Err("Recording expired.".into());
        }
    }
}

impl Audio {
    pub fn start(&self, consent: bool) -> Result<Status, String> {
        if !consent {
            return Err("Agree to audio transfer before recording.".into());
        }
        let mut current = self.0.lock().map_err(|_| "Recording state unavailable.")?;
        if current.as_ref().is_some_and(|s| !s.worker.is_finished()) {
            return Err("A recording is already open. Stop or cancel it first.".into());
        }
        if let Some(old) = current.take() {
            let _ = old.worker.join();
        }
        let id = id()?;
        let buffer = Arc::new(Mutex::new(Buffer::default()));
        let (tx, rx) = mpsc::channel();
        let (opened, ready) = mpsc::channel();
        let captured = buffer.clone();
        let worker = std::thread::spawn(move || {
            let result = record(captured.clone(), rx, opened);
            if let Ok(mut b) = captured.lock() {
                b.samples.zeroize();
            }
            result
        });
        if let Err(error) = ready
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| Err("Microphone startup timed out.".into()))
        {
            let _ = tx.send(Control::Cancel);
            return Err(error);
        }
        *current = Some(Session {
            id: id.clone(),
            control: tx,
            buffer,
            worker,
        });
        drop(current);
        self.status(&id)
    }
    pub fn status(&self, id: &str) -> Result<Status, String> {
        let current = self.0.lock().map_err(|_| "Recording state unavailable.")?;
        let s = current
            .as_ref()
            .filter(|s| s.id == id)
            .ok_or("Recording is no longer open.")?;
        let b = s
            .buffer
            .lock()
            .map_err(|_| "Recording state unavailable.")?;
        Ok(Status {
            id: s.id.clone(),
            phase: if b.error.is_some() {
                "error"
            } else if b.ready {
                "ready"
            } else {
                "recording"
            },
            duration_ms: if b.rate == 0 {
                0
            } else {
                b.samples.len() as u64 * 1000 / u64::from(b.rate)
            },
            bytes: 44 + b.samples.len() * 2,
            error: b.error,
        })
    }
    fn take(&self, id: &str) -> Result<Session, String> {
        let mut current = self.0.lock().map_err(|_| "Recording state unavailable.")?;
        if current.as_ref().is_none_or(|s| s.id != id) {
            return Err("Recording is no longer open.".into());
        }
        current.take().ok_or("Recording is no longer open.".into())
    }
    pub fn stop(&self, id: &str) -> Result<Vec<u8>, String> {
        let s = self.take(id)?;
        s.control
            .send(Control::Stop)
            .map_err(|_| "Recording expired.")?;
        s.worker
            .join()
            .map_err(|_| "Recording stopped unexpectedly.")?
    }
    /// Called from a blocking lifecycle task: signal teardown without waiting on CPAL.
    pub fn cancel_all(&self) {
        if let Ok(mut current) = self.0.lock()
            && let Some(session) = current.take()
        {
            let _ = session.control.send(Control::Cancel);
            // Dropping the handle detaches; the worker owns and wipes the sample buffer.
        }
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let Ok(s) = self.take(id) else {
            return Ok(());
        };
        let _ = s.control.send(Control::Cancel);
        let _ = s.worker.join();
        Ok(())
    }
}

pub mod commands {
    use super::*;
    use crate::ctx::Ctx;
    use tauri::{State, ipc::Response};
    #[tauri::command]
    pub async fn audio_start(ctx: State<'_, Ctx>, consent: bool) -> Result<Status, String> {
        let audio = ctx.audio.clone();
        tokio::task::spawn_blocking(move || audio.start(consent))
            .await
            .map_err(|_| "Microphone startup failed.")?
    }
    #[tauri::command]
    pub fn audio_status(ctx: State<'_, Ctx>, id: String) -> Result<Status, String> {
        ctx.audio.status(&id)
    }
    #[tauri::command]
    pub async fn audio_stop(ctx: State<'_, Ctx>, id: String) -> Result<Response, String> {
        let audio = ctx.audio.clone();
        tokio::task::spawn_blocking(move || audio.stop(&id).map(Response::new))
            .await
            .map_err(|_| "Couldn't stop the microphone.")?
    }
    #[tauri::command]
    pub async fn audio_cancel(ctx: State<'_, Ctx>, id: String) -> Result<(), String> {
        let audio = ctx.audio.clone();
        tokio::task::spawn_blocking(move || audio.cancel(&id))
            .await
            .map_err(|_| "Couldn't cancel the recording.")?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_wav_has_real_duration_and_rejects_malformed_or_excessive_audio() {
        let mut audio = wav(&vec![1; 8000], 8000).unwrap();
        assert_eq!(wav_duration(&audio).unwrap(), 1000);
        audio[24] ^= 1;
        assert!(wav_duration(&audio).is_err());
        assert!(wav(&[], 8000).is_err());
        assert!(wav(&vec![0; 8000 * 120 + 1], 8000).is_err());
        assert!(wav_duration(&vec![0; MAX_BYTES + 1]).is_err());
    }
    #[test]
    fn downmix_is_bounded_and_ignores_samples_after_stop() {
        let mut b = Buffer::default();
        b.rate = 8000;
        b.append(&[1.0f32, -1.0, 0.5, 0.5], 2);
        assert_eq!(b.samples, [0, 16384]);
        b.append(&vec![0i16; 8000 * 120], 1);
        assert_eq!(b.samples.len(), 8000 * 120);
        assert!(b.ready);
        b.append(&[100i16; 200], 1);
        assert_eq!(b.samples.len(), 8000 * 120);
        assert_eq!(
            wav_duration(&wav(&b.samples, b.rate).unwrap()).unwrap(),
            MAX_MS
        );
    }
    #[test]
    fn lifecycle_cancellation_signals_worker_and_forgets_session_without_a_microphone() {
        let audio = Audio::default();
        let (control, receive) = mpsc::channel();
        let (stopped, observed) = mpsc::channel();
        let buffer = Arc::new(Mutex::new(Buffer::default()));
        let worker = std::thread::spawn(move || {
            stopped
                .send(matches!(receive.recv().unwrap(), Control::Cancel))
                .unwrap();
            Ok(Vec::new())
        });
        *audio.0.lock().unwrap() = Some(Session {
            id: "fixture".into(),
            control,
            buffer,
            worker,
        });
        audio.cancel_all();
        assert!(audio.0.lock().unwrap().is_none());
        assert!(observed.recv_timeout(Duration::from_secs(5)).unwrap());
        audio.cancel_all();
    }
    #[test]
    fn consent_is_required_without_opening_a_microphone() {
        assert!(Audio::default().start(false).is_err());
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../../data/speech.json")).unwrap();
        assert_eq!(catalog["max_bytes"], MAX_BYTES);
        assert_eq!(catalog["max_duration_ms"], MAX_MS);
    }
}
