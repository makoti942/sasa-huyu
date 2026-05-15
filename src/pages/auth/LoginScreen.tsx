
import React, { useState, useEffect } from 'react';
import './LoginScreen.css';
import { CreateAccountModal } from './CreateAccountModal';
import { startNewLogin } from '../../auth/NewDerivAuth.js'; // Assuming the path

// A dummy old login handler for illustration. The real one will be passed as a prop.
const dummyOldLoginHandler = () => {
  console.log('Old login button clicked');
  return new Promise(resolve => setTimeout(resolve, 1000));
};

const LoginScreen = ({ onOldLogin = dummyOldLoginHandler, onNewLoginSuccess }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(null);

  // Particle effect
  useEffect(() => {
    const background = document.querySelector('.login-screen-background');
    if (background) {
        for (let i = 0; i < 20; i++) {
            const particle = document.createElement('div');
            particle.className = 'particle';
            particle.style.left = `${Math.random() * 100}vw`;
            particle.style.top = `${Math.random() * 100}vh`;
            particle.style.width = `${Math.random() * 4 + 2}px`;
            particle.style.height = particle.style.width;
            particle.style.animationDuration = `${Math.random() * 12 + 8}s`;
            background.appendChild(particle);
        }
    }
  }, []);

  const handleOldLoginClick = () => {
    setLoading('old');
    onOldLogin().finally(() => setLoading(null));
  };

  const handleNewLoginClick = () => {
      setLoading('new');
      // startNewLogin will redirect, so no need to stop loading animation unless there's an error
      try {
          startNewLogin();
      } catch (error) {
          console.error("New login failed to start", error);
          setLoading(null);
      }
  };

  return (
    <div className="login-screen">
        <div className="login-screen-background"></div>
        <div className="login-card">
            <div className="login-header">
                <h1>MAKOTI TRADERS</h1>
                <p>Professional Trading Platform</p>
            </div>
            <div className="login-buttons">
                <button 
                    className={`btn btn-old-login ${loading === 'old' ? 'loading' : ''}`}
                    onClick={handleOldLoginClick}
                    disabled={loading}
                >
                    <span className="btn-text">Login (Old Accounts)</span>
                    <div className="loader"></div>
                </button>
                <button 
                    className={`btn btn-new-login ${loading === 'new' ? 'loading' : ''}`}
                    onClick={handleNewLoginClick}
                    disabled={loading}
                >
                    <span className="btn-text">Login with New Account</span>
                     <div className="loader"></div>
                </button>
                
                <div className="divider">─────── or ───────</div>

                <button 
                    className="btn btn-create-account"
                    onClick={() => setIsModalOpen(true)}
                    disabled={loading}
                >
                     <span className="btn-text">Create New Account</span>
                </button>
            </div>
        </div>
        <CreateAccountModal 
            isOpen={isModalOpen} 
            onClose={() => setIsModalOpen(false)} 
            onLoginSuccess={onNewLoginSuccess}
        />
    </div>
  );
};

export default LoginScreen;
