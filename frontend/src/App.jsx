import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import MobileRemote from './components/MobileRemote';
import TVPlayer from './components/TVPlayer';
import './App.css';

function Home() {
  return (
    <div className="home-container">
      <div className="glass-card">
        <h1 className="gradient-text">Handoff Experience</h1>
        <p className="subtitle">Select an interface to launch</p>
        <div className="button-group">
          <Link to="/phone" className="btn-modern primary">
            <span className="icon">📱</span> Mobile Remote
          </Link>
          <Link to="/tv" className="btn-modern secondary">
            <span className="icon">📺</span> TV Player
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/phone" element={<MobileRemote />} />
        <Route path="/tv" element={<TVPlayer />} />
      </Routes>
    </Router>
  );
}
