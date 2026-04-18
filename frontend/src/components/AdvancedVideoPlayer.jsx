import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, Volume2, VolumeX, Maximize, Minimize, 
  Settings, PictureInPicture, Loader2, FastForward, Rewind 
} from 'lucide-react';
import './AdvancedVideoPlayer.css';

export default function AdvancedVideoPlayer({ src, poster }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const controlsTimeoutRef = useRef(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isBuffering, setIsBuffering] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  // Initial Autoplay Try
  useEffect(() => {
    if (videoRef.current) {
      const playPromise = videoRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          console.log("Autoplay blocked. User interaction required.");
          setIsPlaying(false);
        });
      }
    }
  }, [src]);

  // TV Remote & Keyboard Event Mapping
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user happened to be in an input field
      if (e.target.tagName === 'INPUT') return;

      const video = videoRef.current;
      if (!video) return;

      switch(e.key) {
        case ' ':
        case 'Enter':
          e.preventDefault();
          video.paused ? video.play() : video.pause();
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime += 10;
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime -= 10;
          break;
        case 'ArrowUp':
          e.preventDefault();
          {
            const newVol = Math.min(video.volume + 0.1, 1);
            video.volume = newVol;
            setVolume(newVol);
            setIsMuted(newVol === 0);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          {
            const newVol = Math.max(video.volume - 0.1, 0);
            video.volume = newVol;
            setVolume(newVol);
            setIsMuted(newVol === 0);
          }
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        default:
          break;
      }

      // Wake up the control bar just like moving the mouse does
      setShowControls(true);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      if (!video.paused) {
        controlsTimeoutRef.current = setTimeout(() => {
          setShowControls(false);
          setShowSpeedMenu(false);
        }, 3000);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Hide controls on inactivity
  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
        setShowSpeedMenu(false);
      }, 3000);
    }
  };

  const handleMouseLeave = () => {
    if (isPlaying) setShowControls(false);
  };

  const togglePlay = () => {
    if (videoRef.current.paused) {
      videoRef.current.play();
    } else {
      videoRef.current.pause();
    }
  };

  const handleTimeUpdate = () => {
    const current = videoRef.current.currentTime;
    const total = videoRef.current.duration;
    setCurrentTime(current);
    setProgress((current / total) * 100);
  };

  const handleLoadedMetadata = () => {
    setDuration(videoRef.current.duration);
    setIsBuffering(false);
  };

  const handleScrubberChange = (e) => {
    const manualChange = Number(e.target.value);
    const newTime = (manualChange / 100) * duration;
    videoRef.current.currentTime = newTime;
    setProgress(manualChange);
  };

  const skipForward = (e) => {
    e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.currentTime += 10;
    }
  };

  const skipBackward = (e) => {
    e.stopPropagation();
    if (videoRef.current) {
      videoRef.current.currentTime -= 10;
    }
  };

  const toggleMute = () => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    videoRef.current.muted = newMuted;
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    videoRef.current.volume = newVolume;
    setIsMuted(newVolume === 0);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const changePlaybackSpeed = (speed) => {
    setPlaybackSpeed(speed);
    videoRef.current.playbackRate = speed;
    setShowSpeedMenu(false);
  };

  const togglePiP = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (error) {
      console.error("PiP error", error);
    }
  };

  const formatTime = (timeInSeconds) => {
    if (isNaN(timeInSeconds)) return "00:00";
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  return (
    <div 
      className={`advanced-player-container ${!showControls && isPlaying ? 'hide-cursor' : ''}`}
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        className="advanced-video-element"
        onClick={togglePlay}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        autoPlay
      />

      {/* Buffering Indicator */}
      {isBuffering && (
        <div className="center-overlay">
          <Loader2 className="spinner-icon" size={64} />
        </div>
      )}

      {/* Play/Pause Center Overlay Animation */}
      {!isPlaying && !isBuffering && (
        <div className="center-overlay" onClick={togglePlay}>
          <div className="center-play-button">
            <Play size={48} fill="currentColor" />
          </div>
        </div>
      )}

      {/* Control Bar */}
      <div className={`controls-wrapper ${showControls ? 'show' : 'hide'}`}>
        
        {/* Scrubber */}
        <div className="scrubber-container">
          <input 
            type="range" 
            className="progress-scrubber"
            min="0" 
            max="100" 
            value={progress || 0}
            onChange={handleScrubberChange}
            style={{ '--progress': `${progress}%` }}
          />
        </div>

        <div className="controls-toolbar">
          <div className="controls-left">
            <button className="control-btn" onClick={skipBackward} title="-10s">
              <Rewind size={20} fill="currentColor" />
            </button>
            <button className="control-btn play-btn" onClick={togglePlay}>
              {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
            </button>
            <button className="control-btn" onClick={skipForward} title="+10s">
              <FastForward size={20} fill="currentColor" />
            </button>

            <div className="volume-container">
              <button className="control-btn" onClick={toggleMute}>
                {isMuted || volume === 0 ? <VolumeX size={24} /> : <Volume2 size={24} />}
              </button>
              <input 
                type="range" 
                className="volume-slider" 
                min="0" 
                max="1" 
                step="0.05" 
                value={isMuted ? 0 : volume} 
                onChange={handleVolumeChange} 
                style={{ '--volume': `${isMuted ? 0 : volume * 100}%` }}
              />
            </div>
            
            <div className="time-display">
              {formatTime(currentTime)} <span className="time-separator">/</span> {formatTime(duration)}
            </div>
          </div>

          <div className="controls-right">
            {/* Playback Speed Menu */}
            <div className="speed-menu-container">
              <button 
                className={`control-btn ${playbackSpeed !== 1 ? 'active' : ''}`} 
                onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              >
                <Settings size={20} />
              </button>
              {showSpeedMenu && (
                <div className="speed-menu">
                  {[0.5, 1, 1.25, 1.5, 2].map(speed => (
                    <button 
                      key={speed} 
                      className={`speed-option ${playbackSpeed === speed ? 'selected' : ''}`}
                      onClick={() => changePlaybackSpeed(speed)}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {document.pictureInPictureEnabled && (
              <button className="control-btn" onClick={togglePiP} title="Picture in Picture">
                <PictureInPicture size={20} />
              </button>
            )}
            
            <button className="control-btn" onClick={toggleFullscreen}>
              {isFullscreen ? <Minimize size={24} /> : <Maximize size={24} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
