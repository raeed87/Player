import React, { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { 
  Tv2, Wifi, WifiOff, Copy, Check, Play, 
  Clock, Trash2, XCircle, MonitorPlay, Radio, 
  Film, Zap, X 
} from 'lucide-react';
import UltimateVideoPlayer from './UltimateVideoPlayer';
import './TVPlayer.css';

// ── Platform detection ────────────────────────────────────────────────────────
const IS_ANDROID = /android/i.test(navigator.userAgent);

// ── App URL scheme builders (Smart Redirection) ─────────────────────────────
function getSmartURL(rawUrl) {
  const IS_ANDROID = /android/i.test(navigator.userAgent);
  if (IS_ANDROID) {
    return `intent:${rawUrl}#Intent;action=android.intent.action.VIEW;type=video/*;end`;
  }
  return rawUrl;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(date) {
  const diff = Math.floor((Date.now() - new Date(date)) / 1000);
  if (diff < 60)    return 'Just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 28) + (u.pathname.length > 28 ? '…' : '');
  } catch { return url.slice(0, 40); }
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function TVPlayer() {
  const [links, setLinks]               = useState([]);
  const [isConnected, setIsConnected]   = useState(false);
  const [activePlayer, setActivePlayer] = useState(null);
  const [probeReady, setProbeReady]     = useState(true);
  const [copiedId, setCopiedId]         = useState(null);
  const seekTimerRef = useRef(null);

  // ── Supabase: load history + subscribe to real-time inserts ──────────────
  useEffect(() => {
    supabase
      .from('video_queue')
      .select('id, url, sent_at')
      .order('sent_at', { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (error) { console.error('[Supabase] Load error:', error.message); return; }
        if (data) setLinks(data.map(r => ({ id: r.id, url: r.url, receivedAt: r.sent_at })));
      });

    const channel = supabase
      .channel('video_queue_inserts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'video_queue' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const r = payload.new;
            setLinks(prev => [{ id: r.id, url: r.url, receivedAt: r.sent_at }, ...prev.slice(0, 49)]);
          } else if (payload.eventType === 'DELETE') {
            setLinks(prev => prev.filter(l => l.id !== payload.old.id));
          }
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => { supabase.removeChannel(channel); };
  }, []);

  const openBuiltinPlayer = useCallback(async (url) => {
    setActivePlayer(null);
    setProbeReady(true);
    setActivePlayer(url);
  }, []);

  const closePlayer = () => setActivePlayer(null);

  const copyUrl = (id, url) => {
    navigator.clipboard.writeText(url)
      .then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      })
      .catch(() => {
        // Fallback for older browsers or insecure contexts
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed'; ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { console.error('Copy failed'); }
        document.body.removeChild(ta);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      });
  };

  const deleteLink = async (id) => {
    try {
      const { error } = await supabase.from('video_queue').delete().eq('id', id);
      if (error) throw error;
      // UI updates automatically via Supabase subscription 'DELETE' event
    } catch (err) {
      console.error('[Supabase] Delete error:', err);
    }
  };

  const clearAllLinks = async () => {
    if (!window.confirm('Are you sure you want to clear the entire history?')) return;
    try {
      const { error } = await supabase.from('video_queue').delete().neq('id', 0);
      if (error) throw error;
    } catch (err) {
      console.error('[Supabase] Clear error:', err);
    }
  };

  const handleSeek = (time) => {
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {}, 800);
  };

  return (
    <div className="tv-root">
      {/* Header */}
      <header className="tv-header">
        <div className="tv-header-left">
          <Tv2 className="tv-logo-icon" size={28} />
          <span className="tv-logo-text">StreamCast TV</span>
        </div>
        <div className="tv-header-right">
          {links.length > 0 && (
            <button className="clear-all-btn" onClick={clearAllLinks}>
              <XCircle size={16} />
              <span>Clear History</span>
            </button>
          )}
          <div className={`tv-status ${isConnected ? 'connected' : 'offline'}`}>
            {isConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
            <span>{isConnected ? 'Live' : 'Connecting…'}</span>
          </div>
        </div>
      </header>

      {/* Link List */}
      <main className="tv-main">
        {links.length === 0 ? (
          <div className="tv-empty">
            <div className="tv-empty-icon">
              <div className="pulse-ring" />
              <div className="pulse-ring ring-2" />
              <MonitorPlay size={64} />
            </div>
            <h2>Ready to Cast</h2>
            <p>Open the <strong>Handoff Remote</strong> on your phone<br />and paste a video link to get started.</p>
            <div className={`tv-badge ${isConnected ? 'connected' : 'offline'}`}>
              <Radio size={14} />
              <span>{isConnected ? 'Listening for links…' : 'Connecting to Supabase…'}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="tv-list-header">
              <Film size={18} />
              <span>Received Links</span>
              <span className="tv-count">{links.length}</span>
            </div>

            <div className="tv-link-list">
              {links.map((link, i) => (
                <div key={link.id ?? (link.url + i)} className="tv-link-card">
                  <div className="card-index">{i + 1}</div>

                  <div className="card-info">
                    <div className="card-url" title={link.url}>{shortUrl(link.url)}</div>
                    <div className="card-meta">
                      <Clock size={11} />
                      <span>{timeAgo(link.receivedAt)}</span>
                    </div>
                  </div>

                  <div className="card-actions">
                    {/* Copy Button */}
                    <button
                      className={`action-btn copy-btn ${copiedId === link.id ? 'copied' : ''}`}
                      onClick={() => copyUrl(link.id, link.url)}
                      title="Copy URL">
                      {copiedId === link.id
                        ? <><Check size={14} className="btn-icon" /><span className="btn-label">Copied!</span></>
                        : <><Copy size={14} className="btn-icon" /><span className="btn-label">Copy URL</span></>}
                    </button>

                    {/* Native App Buttons (Smart Redirection) */}
                    <a className="action-btn mx" href={getSmartURL(link.url)} target="_blank" rel="noreferrer" title="Open with MX Player (Android) or Browser (PC)">
                      <span className="btn-icon">MX</span>
                      <span className="btn-label">MX</span>
                    </a>
                    <a className="action-btn vlc" href={getSmartURL(link.url)} target="_blank" rel="noreferrer" title="Open with VLC (Android) or Browser (PC)">
                      <span className="btn-icon">▶</span>
                      <span className="btn-label">VLC</span>
                    </a>
                    <a className="action-btn universal" href={getSmartURL(link.url)} target="_blank" rel="noreferrer" title="Choose ANY video app">
                      <span className="btn-icon">📦</span>
                      <span className="btn-label">Choose App</span>
                    </a>

                    {/* In-Browser Player */}
                    <button className="action-btn builtin" onClick={() => openBuiltinPlayer(link.url)} title="Play in browser">
                      <Play size={14} className="btn-icon" />
                      <span className="btn-label">Our Player</span>
                    </button>

                    <div className="card-actions-divider" />

                    {/* Delete Button */}
                    <button className="action-btn delete-btn" onClick={() => deleteLink(link.id)} title="Delete from list">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {/* Built-in Player Overlay */}
      {activePlayer && (
        <div className="player-overlay">
          <button className="overlay-close" onClick={closePlayer}>
            <X size={22} />
            <span>Back to Links</span>
          </button>

          {!probeReady && (
            <div className="overlay-loading">
              <Zap size={40} className="spin-icon" />
              <p>Preparing stream…</p>
            </div>
          )}

          {probeReady && (
            <UltimateVideoPlayer
              src={activePlayer}
              onCdnError={() => {}}
              onIncompatibleAudio={() => {}}
              onAudioTracks={() => {}}
              onSeek={handleSeek}
            />
          )}
        </div>
      )}
    </div>
  );
}
