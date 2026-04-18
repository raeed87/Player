import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Send, Tv, AlertCircle, CheckCircle2, Play, Copy, ExternalLink } from 'lucide-react';
import './MobileRemote.css';

// ── App URL scheme builders (Smart Redirection) ─────────────────────────────
function getSmartURL(rawUrl) {
  const IS_ANDROID = /android/i.test(navigator.userAgent);
  if (IS_ANDROID) {
    return `intent:${rawUrl}#Intent;action=android.intent.action.VIEW;type=video/*;end`;
  }
  return rawUrl;
}

export default function MobileRemote() {
  const [url, setUrl]         = useState('');
  const [status, setStatus]   = useState({ type: '', message: '' });
  const [isSending, setIsSending] = useState(false);

  const handleSendToTV = async (e) => {
    e.preventDefault();
    if (!url.trim()) {
      setStatus({ type: 'error', message: 'Please enter a video URL' });
      return;
    }

    setIsSending(true);
    setStatus({ type: '', message: '' });

    try {
      const { error } = await supabase
        .from('video_queue')
        .insert({ url: url.trim() });

      if (error) throw error;

      setStatus({ type: 'success', message: '✓ Video sent to TV!' });
      setUrl('');
      setTimeout(() => setStatus({ type: '', message: '' }), 3000);
    } catch (err) {
      console.error('[Supabase] Insert error:', err);
      setStatus({ type: 'error', message: 'Failed to send — check your connection.' });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="mobile-remote-wrapper">
      <div className="mobile-header">
        <Tv className="header-icon" />
        <h2>Handoff Remote</h2>
      </div>

      <div className="remote-card">
        <p className="instruction-text">
          Paste a video link below and cast it instantly to your TV.
        </p>

        <form onSubmit={handleSendToTV} className="input-group">
          <div className="input-wrapper">
            <input
              type="url"
              placeholder="Paste video URL here..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="url-input"
              autoComplete="off"
            />
            {url && (
              <button type="button" className="clear-btn" onClick={() => setUrl('')}>
                &times;
              </button>
            )}
          </div>

          {status.message && (
            <div className={`status-message ${status.type} slide-in`}>
              {status.type === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
              <span>{status.message}</span>
            </div>
          )}

          <button
            type="submit"
            className={`cast-btn ${isSending ? 'pulse' : ''}`}
            disabled={isSending}
          >
            {isSending ? (
              <span className="spinner"></span>
            ) : (
              <>
                <Send size={18} />
                <span>Cast to TV</span>
              </>
            )}
          </button>
        </form>

        {url && (
          <div className="local-play-options slide-in">
            <div className="divider"><span>OR PLAY ON PHONE</span></div>
            <div className="play-grid">
              <a href={getSmartURL(url)} target="_blank" rel="noreferrer" className="p-btn mx">MX Player</a>
              <a href={getSmartURL(url)} target="_blank" rel="noreferrer" className="p-btn vlc">VLC</a>
              <a href={getSmartURL(url)} target="_blank" rel="noreferrer" className="p-btn universal">
                <ExternalLink size={14} /> Choose App
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
