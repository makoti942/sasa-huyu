
import React, { useState, useEffect, useRef, useCallback } from 'react';
import './app-loader.scss';

// Module-level flag: stays true once user clicks play, survives component remount
let _audioUnlocked = false;
export function isAudioUnlocked() { return _audioUnlocked; }

interface AppLoaderProps {
    onLoadingComplete: () => void;
}

function speak(text: string) {
    return new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1.1;
        utterance.volume = 1;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
    });
}

const AppLoader: React.FC<AppLoaderProps> = ({ onLoadingComplete }) => {
    const [show, setShow] = useState(true);
    const [soundStarted, setSoundStarted] = useState(_audioUnlocked);
    const logoText = "MAKOTI TRADERS";

    const doSpeak = useCallback(async () => {
        if (_audioUnlocked) return;
        _audioUnlocked = true;
        setSoundStarted(true);
        await speak('WELCOME TO MAKOTI TRADERS');
    }, []);

    useEffect(() => {
        const sequenceTimer = setTimeout(() => {
            setShow(false);
            onLoadingComplete();
        }, 4000);

        return () => {
            clearTimeout(sequenceTimer);
        };
    }, [onLoadingComplete]);

    if (!show) return null;

    return (
        <div className='gta-loader'>
            <div className='scene'>
                <div className='siren-light red'></div>
                <div className='siren-light blue'></div>
                <div className='wet-ground'></div>
            </div>

            <div className='logo-container'>
                <h1 className='logo-text'>{logoText}</h1>
            </div>

            <p className='subtitle subtitle-1'>&gt; Initializing Trading Matrix...</p>
            <p className='subtitle subtitle-2'>&gt; Loading Strategies: Martingale, D'Alembert, Oscar's Grind...</p>
            <p className='subtitle subtitle-3'>&gt; Activating AI Core: Version 2.0</p>
            <p className='subtitle subtitle-4'>&gt; Real-time Analytics & Reporting</p>
            <p className='subtitle subtitle-5'>&gt; Welcome, Trader.</p>

            {!soundStarted && (
                <button className='sound-unlock-btn' onClick={doSpeak}>
                    🔊 PLAY SOUND
                </button>
            )}

            <div className='film-grain'></div>
            <div className='vignette'></div>
            <div className='scanlines'></div>
        </div>
    );
};

export default AppLoader;
