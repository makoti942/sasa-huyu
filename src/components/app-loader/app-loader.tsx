
import React, { useState, useEffect, useCallback } from 'react';
import './app-loader.scss';

let _audioUnlocked = false;
export function isAudioUnlocked() { return _audioUnlocked; }

interface AppLoaderProps {
    onLoadingComplete: () => void;
}

function speak(text: string) {
    return new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.8;
        utterance.pitch = 1.0;
        utterance.volume = 1;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
    });
}

const SUBTITLES = [
    '> LOADING TRADING MODULES...',
    '> CALIBRATING STRATEGIES...',
    '> WARMING UP ENGINES...',
    '> ALMOST READY...',
];

const DURATION = 4000;

const AppLoader: React.FC<AppLoaderProps> = ({ onLoadingComplete }) => {
    const [show, setShow] = useState(true);
    const [soundStarted, setSoundStarted] = useState(_audioUnlocked);
    const [subIndex, setSubIndex] = useState(-1);

    const doSpeak = useCallback(async () => {
        if (_audioUnlocked) return;
        _audioUnlocked = true;
        setSoundStarted(true);
        await speak('WELCOME TO MAKOTI TRADERS');
    }, []);

    useEffect(() => {
        const subInterval = setInterval(() => {
            setSubIndex(prev => Math.min(prev + 1, SUBTITLES.length - 1));
        }, 900);

        const timer = setTimeout(() => {
            setShow(false);
            onLoadingComplete();
        }, DURATION);

        return () => {
            clearTimeout(timer);
            clearInterval(subInterval);
        };
    }, [onLoadingComplete]);

    if (!show) return null;

    return (
        <div className='gta-loader'>
            <div className='retro-bg'>
                <div className='cityscape'></div>
                <div className='stars'></div>
            </div>

            <div className='logo-container'>
                <h1 className='logo-text'>MAKOTI TRADERS</h1>
                <div className='logo-sub'>EST. 2024</div>
            </div>

            <div className='track-container'>
                <div className='track-road'>
                    <div className='track-lanes'></div>
                    <div className='track-fill'></div>
                </div>
                <div className='checkered-flag'>
                    <div className='flag-pole'></div>
                    <div className='flag-banner'></div>
                </div>
                <div className='runner'>
                    <div className='runner__head'></div>
                    <div className='runner__body'>
                        <span className='runner__face'>😎</span>
                    </div>
                    <div className='runner__leg runner__leg--left'></div>
                    <div className='runner__leg runner__leg--right'></div>
                    <div className='runner__arm'></div>
                </div>
            </div>

            <div className='subtitle-box'>
                {subIndex >= 0 && (
                    <p key={subIndex} className='subtitle'>{SUBTITLES[subIndex]}</p>
                )}
            </div>

            {!soundStarted && (
                <button className='sound-btn' onClick={doSpeak}>
                    🔊 PRESS START
                </button>
            )}

            <div className='pixel-overlay'></div>
        </div>
    );
};

export default AppLoader;
