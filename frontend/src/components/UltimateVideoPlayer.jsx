import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize,
  PictureInPicture2, Loader2, FastForward, Rewind,
  Subtitles, Layers, Zap, Radio, ChevronUp
} from 'lucide-react';
import './UltimateVideoPlayer.css';

// ─── SRT/VTT Parser ─────────────────────────────────────────────────────────
function parseTimestamp(ts) {
  const clean = ts.replace(',', '.');
  const parts = clean.split(':');
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

function parseSRT(content) {
  const blocks = content.trim().split(/\n\s*\n/);
  return blocks.flatMap(block => {
    const lines = block.trim().split('\n');
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) return [];
    const [start, end] = timeLine.split('-->').map(t => parseTimestamp(t.trim()));
    const text = lines.slice(lines.indexOf(timeLine) + 1).join('\n');
    return [{ start, end, text }];
  });
}

function parseVTT(content) {
  return parseSRT(content.replace(/^WEBVTT.*\n?/m, ''));
}

// ─── Helper: format time display ─────────────────────────────────────────────
function fmtTime(t) {
  if (!t || isNaN(t)) return '0:00';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Helper: language code → flag emoji ──────────────────────────────────────
function langFlag(lang) {
  if (!lang) return '🎵';
  const map = { eng: '🇬🇧', en: '🇬🇧', hin: '🇮🇳', hi: '🇮🇳', tam: '🇮🇳', tel: '🇮🇳',
    jpn: '🇯🇵', ja: '🇯🇵', kor: '🇰🇷', ko: '🇰🇷', fra: '🇫🇷', fr: '🇫🇷',
    deu: '🇩🇪', de: '🇩🇪', spa: '🇪🇸', es: '🇪🇸', ara: '🇸🇦', ar: '🇸🇦',
    por: '🇧🇷', pt: '🇧🇷', rus: '🇷🇺', ru: '🇷🇺', zho: '🇨🇳', zh: '🇨🇳' };
  return map[lang.toLowerCase()] || '🎵';
}

function formatTrackLabel(track, index) {
  const flag  = langFlag(track.lang || track.language);
  const lang  = (track.lang || track.language || '').toUpperCase() || `Track ${index + 1}`;
  const title = track.name || track.title || '';
  return `${flag} ${lang}${title ? ` · ${title}` : ''}`;
}

// ── Safe play helper ─────────────────────────────────────────────────────────
// Suppresses AbortError which fires in two normal situations:
//  1. play() interrupted by a src change (React re-render)
//  2. play() interrupted because component unmounted (media removed from DOM)
// Both are expected React lifecycle events, not real errors.
function safePlay(video) {
  if (!video || !video.src) return; // Already unmounted/cleared
  const p = video.play();
  if (p !== undefined) {
    p.catch(e => {
      // AbortError is always safe to ignore — it's a browser lifecycle signal
      if (e.name !== 'AbortError') {
        console.warn('[Player] play() error:', e.message);
      }
    });
  }
}

export default function UltimateVideoPlayer({ src, onCdnError, onIncompatibleAudio, onAudioTracks, onSeek }) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const thumbVideoRef = useRef(null);
  const ambilightRef = useRef(null);
  const ambilightRafRef = useRef(null);
  const hlsRef = useRef(null);
  const controlsTimerRef = useRef(null);
  const gamepadRafRef = useRef(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [bufferProgress, setBufferProgress] = useState(0); // 0-100 for loading bar
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  // Advanced features state
  const [ambilightOn, setAmbilightOn] = useState(true);
  const [subtitles, setSubtitles] = useState([]);
  const [currentSubtitle, setCurrentSubtitle] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [subFileName, setSubFileName] = useState('');
  const [audioTracks, setAudioTracks] = useState([]);
  const [currentAudioTrack, setCurrentAudioTrack] = useState(0);
  const [nativeAudioMode, setNativeAudioMode] = useState(false); // true = use HTMLMediaElement.audioTracks
  const [qualityLevels, setQualityLevels] = useState([]);
  const [currentQuality, setCurrentQuality] = useState(-1); // -1 = Auto
  const [hoverTime, setHoverTime] = useState(null);
  const [hoverX, setHoverX] = useState(0);
  const [thumbSrc, setThumbSrc] = useState('');
  const [gamepadConnected, setGamepadConnected] = useState(false);

  // Menus
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showAudioMenu, setShowAudioMenu] = useState(false);
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  // ── HLS.js Setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    // 🔗 Dynamically inject a <link rel="preconnect"> for the proxy host
    // This fires 200ms before the actual video request, pre-opening the TCP socket
    try {
      const proxyHost = new URL(src).origin;
      if (!document.querySelector(`link[href="${proxyHost}"]`)) {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = proxyHost;
        document.head.appendChild(link);
      }
    } catch (_) {}

    // Clean previous hls instance
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const isHLS = src.includes('.m3u8');

    if (isHLS && Hls.isSupported()) {
      const hls = new Hls({
        // ── Startup Speed ──────────────────────────────────────────
        startLevel: -1,           // Auto-select best quality immediately
        autoStartLoad: true,
        startFragPrefetch: true,  // Pre-fetch the first segment before play()
        // ── Buffer size: bigger = smoother, less rebuffering ────────
        maxBufferLength: 90,      // Keep 90s ahead in buffer
        maxMaxBufferLength: 150,  // Allow up to 150s in high-bandwidth situations
        maxBufferSize: 150 * 1000 * 1000, // 150MB buffer ceiling
        maxBufferHole: 0.5,       // Tolerate tiny gaps without stalling
        // ── ABR / Bandwidth estimation ───────────────────────────
        abrEwmaDefaultEstimate: 10_000_000, // Assume 10Mbps on first load (skip low-quality first)
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        // ── Network / Retry ─────────────────────────────────────
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 500,
        levelLoadingRetryDelay: 500,
        fragLoadingRetryDelay: 500,
        // ── Low-latency mode ────────────────────────────────────
        lowLatencyMode: false, // false for VOD; true only for live streams
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setQualityLevels(hls.levels);
        safePlay(video);
      });

      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        setAudioTracks(hls.audioTracks);
        setCurrentAudioTrack(hls.audioTrack);
      });

      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
        setCurrentAudioTrack(data.id);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        setCurrentQuality(data.level);
      });

      // ── Error Recovery ─────────────────────────────────────────────────────
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.warn('[HLS] Network error, attempting recovery...', data);
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.warn('[HLS] Media error, attempting recovery...', data);
              hls.recoverMediaError();
              break;
            default:
              console.error('[HLS] Unrecoverable error:', data);
              hls.destroy();
              break;
          }
        }
      });
    } else {
      // Direct stream (proxy CDN, mp4, webm, etc.)
      video.src = src;
      video.preload = 'auto';
      safePlay(video);
    }

    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [src]);

  // ── Probe backend for audio track metadata (ffprobe) ──────────────────────────
  // Purpose: get rich track info (language, codec name) for the UI track selector.
  // Audio routing (EAC3 → remux) is handled TRANSPARENTLY by the backend.
  // We must NOT change video.src here — doing so would interrupt the stream.
  const probeAudioTracks = useCallback(async (streamSrc) => {
    try {
      const srcUrl = new URL(streamSrc);
      const orig   = srcUrl.searchParams.get('url');
      if (!orig) return;

      const res  = await fetch(`${srcUrl.origin}/api/probe?url=${encodeURIComponent(orig)}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.audioTracks && data.audioTracks.length > 0) {
        setAudioTracks(data.audioTracks);
        setNativeAudioMode(true);
        setCurrentAudioTrack(0);
        if (onAudioTracks) onAudioTracks(data.audioTracks);
        // Notify parent for optional UI indicator — backend already fixed the audio
        const incompatible = data.audioTracks.some(t =>
          ['eac3', 'ac3', 'dts', 'truehd'].includes(t.codec?.toLowerCase())
        );
        if (incompatible && onIncompatibleAudio) onIncompatibleAudio(true);
      }
    } catch (_) { /* probe is best-effort, never block playback */ }
  }, [onAudioTracks, onIncompatibleAudio]);

  // ── Ambilight Canvas ────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = ambilightRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const drawAmbilight = () => {
      if (ambilightOn && !video.paused && !video.ended) {
        const ctx = canvas.getContext('2d');
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      ambilightRafRef.current = requestAnimationFrame(drawAmbilight);
    };

    ambilightRafRef.current = requestAnimationFrame(drawAmbilight);
    return () => cancelAnimationFrame(ambilightRafRef.current);
  }, [ambilightOn]);




  // ── Subtitle Sync ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!subtitles.length) return;
    const match = subtitles.find(c => currentTime >= c.start && currentTime <= c.end);
    setCurrentSubtitle(match ? match.text : '');
  }, [currentTime, subtitles]);

  // ── Gamepad Polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    const pollGamepad = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = Array.from(pads).find(p => p);
      const video = videoRef.current;
      if (pad && video) {
        setGamepadConnected(true);
        const [A, B, , , , , , , , , , , DUp, DDown, DLeft, DRight] = pad.buttons.map(b => b.pressed);
        if (A) video.paused ? safePlay(video) : video.pause();
        if (DRight) { video.currentTime += 10; if (onSeek) onSeek(video.currentTime); }
        if (DLeft) { video.currentTime -= 10; if (onSeek) onSeek(video.currentTime); }
        if (DUp) video.volume = Math.min(video.volume + 0.1, 1);
        if (DDown) video.volume = Math.max(video.volume - 0.1, 0);
        if (B && document.fullscreenElement) document.exitFullscreen();
      } else {
        setGamepadConnected(false);
      }
      gamepadRafRef.current = requestAnimationFrame(pollGamepad);
    };

    const onConnect = () => gamepadRafRef.current = requestAnimationFrame(pollGamepad);
    const onDisconnect = () => {
      cancelAnimationFrame(gamepadRafRef.current);
      setGamepadConnected(false);
    };

    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    return () => {
      cancelAnimationFrame(gamepadRafRef.current);
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
    };
  }, []);

  // ── Keyboard / TV Remote ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const video = videoRef.current;
      if (!video) return;
      switch (e.key) {
        case ' ': case 'Enter': e.preventDefault(); video.paused ? safePlay(video) : video.pause(); break;
        case 'ArrowRight': e.preventDefault(); video.currentTime += 10; if (onSeek) onSeek(video.currentTime); break;
        case 'ArrowLeft':  e.preventDefault(); video.currentTime -= 10; if (onSeek) onSeek(video.currentTime); break;
        case 'ArrowUp':    e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); break;
        case 'ArrowDown':  e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); break;
        case 'm': case 'M': video.muted = !video.muted; break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'p': case 'P': togglePiP(); break;
        default: break;
      }
      wakeControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Fullscreen listener ─────────────────────────────────────────────────────
  useEffect(() => {
    const onFS = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFS);
    return () => document.removeEventListener('fullscreenchange', onFS);
  }, []);

  // ── Controls Auto-hide ──────────────────────────────────────────────────────
  const wakeControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setShowControls(false);
      setShowSpeedMenu(false);
      setShowAudioMenu(false);
      setShowQualityMenu(false);
    }, 3500);
  }, []);

  // ── Video Event Handlers ────────────────────────────────────────────────────
  const handleTimeUpdate = () => {
    const v = videoRef.current;
    setCurrentTime(v.currentTime);
    setProgress((v.currentTime / v.duration) * 100 || 0);
    // Track buffered amount to display loading bar
    if (v.buffered.length > 0) {
      const bufferedEnd = v.buffered.end(v.buffered.length - 1);
      setBufferProgress((bufferedEnd / v.duration) * 100 || 0);
    }
  };

  const handleScrub = (e) => {
    const v = videoRef.current;
    const pct = Number(e.target.value);
    const newTime = (pct / 100) * v.duration;
    v.currentTime = newTime;
    setProgress(pct);
    if (onSeek) onSeek(newTime);
  };

  const handleScrubHover = (e) => {
    const rect = e.target.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const t = pct * duration;
    setHoverTime(t);
    setHoverX(e.clientX - rect.left);

    // Thumbnail preview via thumb video
    const thumb = thumbVideoRef.current;
    if (thumb && duration > 0) {
      thumb.currentTime = t;
    }
  };

  const handleScrubLeave = () => setHoverTime(null);

  // ── Subtitle Drag & Drop ───────────────────────────────────────────────────
  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    setSubFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target.result;
      const cues = file.name.endsWith('.vtt') ? parseVTT(content) : parseSRT(content);
      setSubtitles(cues);
    };
    reader.readAsText(file);
  };

  // ── Controls ────────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    v.paused ? safePlay(v) : v.pause();
  };

  const toggleMute = () => {
    const v = videoRef.current;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    videoRef.current.volume = val;
    setVolume(val);
    setIsMuted(val === 0);
  };

  const changeSpeed = (speed) => {
    videoRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
    setShowSpeedMenu(false);
  };

  const changeAudioTrack = (id) => {
    if (hlsRef.current) {
      // HLS.js audio track switching
      hlsRef.current.audioTrack = id;
    } else if (nativeAudioMode) {
      // Native HTMLMediaElement.audioTracks — disable all, enable selected
      const video = videoRef.current;
      if (video && video.audioTracks) {
        Array.from(video.audioTracks).forEach((track, i) => {
          track.enabled = (i === id);
        });
      }
    }
    setCurrentAudioTrack(id);
    setShowAudioMenu(false);
  };

  const changeQuality = (level) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = level;
      setCurrentQuality(level);
    }
    setShowQualityMenu(false);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen();
    }
  };

  const togglePiP = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) { console.error(err); }
  };

  const handleThumbSeeked = () => {
    const thumb = thumbVideoRef.current;
    if (!thumb) return;
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 90;
    canvas.getContext('2d').drawImage(thumb, 0, 0, 160, 90);
    setThumbSrc(canvas.toDataURL());
  };

  const hideAllMenus = () => {
    setShowSpeedMenu(false);
    setShowAudioMenu(false);
    setShowQualityMenu(false);
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className={`ultimate-player ${!showControls && isPlaying ? 'cursor-none' : ''}`}
      onMouseMove={wakeControls}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ── Ambilight Canvas ── */}
      <canvas
        ref={ambilightRef}
        className={`ambilight-canvas ${ambilightOn ? 'active' : ''}`}
      />

      {/* ── Main Video ── */}
      <video
        ref={videoRef}
        className="ultimate-video"
        onClick={togglePlay}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={(e) => {
          const video = e.target;
          setDuration(video.duration);
          setIsBuffering(false);

          // ── Native HTMLMediaElement audioTracks detection ──
          // Works in Chrome. Detects multi-audio .mkv/.mp4 files played via direct proxy.
          if (!hlsRef.current && video.audioTracks && video.audioTracks.length > 0) {
            const tracks = Array.from(video.audioTracks).map((t, i) => ({
              id: i,
              name: t.label || undefined,
              lang: t.language || undefined,
            }));
            setAudioTracks(tracks);
            setNativeAudioMode(true);
            setCurrentAudioTrack(0);
            // Ensure first track enabled
            Array.from(video.audioTracks).forEach((t, i) => { t.enabled = (i === 0); });
          }

          // Also try the ffprobe endpoint for richer metadata
          if (!hlsRef.current) probeAudioTracks(src);
        }}
        onVolumeChange={(e) => {
          setVolume(e.target.volume);
          setIsMuted(e.target.muted);
        }}
        onError={(e) => {
          console.error('Video error:', e);
          if (onCdnError && videoRef.current?.error?.code >= 2) onCdnError();
        }}
        crossOrigin="anonymous"
        preload="auto"
      />

      {/* ── Hidden thumbnail scrubber video ── */}
      <video
        ref={thumbVideoRef}
        src={src}
        className="thumb-video"
        onSeeked={handleThumbSeeked}
        crossOrigin="anonymous"
        preload="metadata"
        muted
      />

      {/* ── Buffering: Netflix-style top bar + centered spinner ── */}
      {isBuffering && (
        <div className="center-overlay">
          <div className="buffer-bar" style={{ width: `${bufferProgress}%` }} />
          <div className="buffer-info">
            <Loader2 className="spin-icon" size={48} />
            {bufferProgress > 0 && (
              <span className="buffer-pct">{Math.round(bufferProgress)}% buffered</span>
            )}
          </div>
        </div>
      )}

      {/* ── Center Play Flash ── */}
      {!isPlaying && !isBuffering && (
        <div className="center-overlay clickable" onClick={togglePlay}>
          <div className="center-play-ring">
            <Play size={48} fill="currentColor" />
          </div>
        </div>
      )}

      {/* ── Subtitle Text ── */}
      {currentSubtitle && (
        <div
          className="subtitle-overlay"
          dangerouslySetInnerHTML={{ __html: currentSubtitle.replace(/\n/g, '<br/>') }}
        />
      )}

      {/* ── Drag-to-add subtitle indicator ── */}
      {isDragging && (
        <div className="drop-zone-overlay">
          <Subtitles size={48} />
          <p>Drop .srt or .vtt subtitle file here</p>
        </div>
      )}

      {/* ── Status badges ── */}
      <div className="status-badges">
        {gamepadConnected && (
          <div className="badge badge-gamepad">
            <Zap size={12} /> Gamepad
          </div>
        )}
        {subFileName && (
          <div className="badge badge-sub">
            <Subtitles size={12} /> {subFileName}
          </div>
        )}
        {ambilightOn && (
          <div className="badge badge-ambi">
            <Radio size={12} /> Ambilight
          </div>
        )}
      </div>

      {/* ── Controls ── */}
      <div className={`controls-shell ${showControls ? 'visible' : 'hidden'}`} onClick={hideAllMenus}>

        {/* Thumbnail Preview */}
        {hoverTime !== null && thumbSrc && (
          <div className="thumb-preview" style={{ left: Math.max(8, Math.min(hoverX - 80, (containerRef.current?.clientWidth || 400) - 168)) }}>
            <img src={thumbSrc} alt="preview" />
            <span>{fmtTime(hoverTime)}</span>
          </div>
        )}

        {/* Progress */}
        <div className="scrubber-row">
          <input
            type="range" min="0" max="100" step="0.1"
            value={progress}
            className="scrubber"
            style={{ '--prog': `${progress}%`, '--buff': `${bufferProgress}%` }}
            onChange={handleScrub}
            onMouseMove={handleScrubHover}
            onMouseLeave={handleScrubLeave}
          />
        </div>

        {/* Toolbar */}
        <div className="toolbar" onClick={e => e.stopPropagation()}>

          {/* LEFT */}
          <div className="toolbar-left">
            <button className="ctrl-btn" onClick={() => { videoRef.current.currentTime -= 10; }} title="-10s">
              <Rewind size={18} fill="currentColor" />
            </button>
            <button className="ctrl-btn play-btn" onClick={togglePlay}>
              {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
            </button>
            <button className="ctrl-btn" onClick={() => { videoRef.current.currentTime += 10; }} title="+10s">
              <FastForward size={18} fill="currentColor" />
            </button>

            <div className="vol-group">
              <button className="ctrl-btn" onClick={toggleMute}>
                {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
              </button>
              <input
                type="range" min="0" max="1" step="0.02"
                value={isMuted ? 0 : volume}
                className="vol-slider"
                style={{ '--vol': `${(isMuted ? 0 : volume) * 100}%` }}
                onChange={handleVolumeChange}
              />
            </div>

            <span className="time-readout">
              {fmtTime(currentTime)} <span className="time-sep">/</span> {fmtTime(duration)}
            </span>
          </div>

          {/* RIGHT */}
          <div className="toolbar-right">

            {/* Ambilight Toggle */}
            <button
              className={`ctrl-btn ${ambilightOn ? 'active-glow' : ''}`}
              onClick={() => setAmbilightOn(a => !a)}
              title="Ambilight"
            >
              <Radio size={18} />
            </button>

            {/* Audio Tracks — always visible, dimmed if only 1 track */}
            <div className="popup-wrap">
              <button
                className={`ctrl-btn audio-track-btn ${showAudioMenu ? 'active-glow' : ''} ${audioTracks.length > 1 ? 'has-tracks' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (audioTracks.length > 0) {
                    setShowAudioMenu(m => !m);
                    setShowSpeedMenu(false);
                    setShowQualityMenu(false);
                  }
                }}
                title={audioTracks.length > 1 ? 'Switch Audio Track' : 'Audio (single track)'}
              >
                <Layers size={18} />
                {audioTracks.length > 1 && (
                  <span className="track-count-badge">{audioTracks.length}</span>
                )}
              </button>
              {showAudioMenu && audioTracks.length > 0 && (
                <div className="popup-menu audio-popup" onClick={e => e.stopPropagation()}>
                  <div className="popup-title">🎵 Audio Track</div>
                  {audioTracks.map((t, i) => (
                    <button
                      key={i}
                      className={`popup-item ${currentAudioTrack === i ? 'selected' : ''}`}
                      onClick={() => changeAudioTrack(i)}
                    >
                      <span className="track-label">{formatTrackLabel(t, i)}</span>
                      {currentAudioTrack === i && <span className="track-active-dot">●</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Quality Selector */}
            {qualityLevels.length > 0 && (
              <div className="popup-wrap">
                <button
                  className={`ctrl-btn ${showQualityMenu ? 'active-glow' : ''}`}
                  onClick={(e) => { e.stopPropagation(); setShowQualityMenu(m => !m); setShowSpeedMenu(false); setShowAudioMenu(false); }}
                  title="Quality"
                >
                  <span className="quality-label">
                    {currentQuality === -1 ? 'AUTO' : `${qualityLevels[currentQuality]?.height}p`}
                  </span>
                </button>
                {showQualityMenu && (
                  <div className="popup-menu" onClick={e => e.stopPropagation()}>
                    <div className="popup-title">Quality</div>
                    <button
                      className={`popup-item ${currentQuality === -1 ? 'selected' : ''}`}
                      onClick={() => changeQuality(-1)}
                    >Auto (Adaptive)</button>
                    {qualityLevels.map((l, i) => (
                      <button
                        key={i}
                        className={`popup-item ${currentQuality === i ? 'selected' : ''}`}
                        onClick={() => changeQuality(i)}
                      >
                        {l.height}p {l.bitrate > 0 ? `· ${Math.round(l.bitrate / 1000)}k` : ''}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Speed Menu */}
            <div className="popup-wrap">
              <button
                className={`ctrl-btn ${playbackSpeed !== 1 ? 'active-glow' : ''}`}
                onClick={(e) => { e.stopPropagation(); setShowSpeedMenu(m => !m); setShowAudioMenu(false); setShowQualityMenu(false); }}
                title="Speed"
              >
                <span className="quality-label">{playbackSpeed}×</span>
              </button>
              {showSpeedMenu && (
                <div className="popup-menu" onClick={e => e.stopPropagation()}>
                  <div className="popup-title">Speed</div>
                  {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(s => (
                    <button
                      key={s}
                      className={`popup-item ${playbackSpeed === s ? 'selected' : ''}`}
                      onClick={() => changeSpeed(s)}
                    >{s}×</button>
                  ))}
                </div>
              )}
            </div>

            {/* PiP */}
            {document.pictureInPictureEnabled && (
              <button className="ctrl-btn" onClick={togglePiP} title="Picture in Picture">
                <PictureInPicture2 size={18} />
              </button>
            )}

            {/* Fullscreen */}
            <button className="ctrl-btn" onClick={toggleFullscreen} title="Fullscreen">
              {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
