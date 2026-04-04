
import React, { useState, useEffect, useRef } from 'react';
import './app-loader.scss';

interface AppLoaderProps {
    onLoadingComplete: () => void;
}

const AppLoader: React.FC<AppLoaderProps> = ({ onLoadingComplete }) => {
    const [show, setShow] = useState(true);
    const clangSoundRef = useRef<HTMLAudioElement | null>(null);
    const sirenSoundRef = useRef<HTMLAudioElement | null>(null);
    const logoText = "MAKOTI TRADERS";

    useEffect(() => {
        // --- SOUND INITIALIZATION ---
        try {
            sirenSoundRef.current = new Audio('/assets/media/siren.mp3');
            sirenSoundRef.current.loop = true;
            sirenSoundRef.current.volume = 0.2;
        } catch (e) { 
            console.error('Siren sound not found. Place it in /public/assets/media/siren.mp3');
        }

        try {
            clangSoundRef.current = new Audio('/assets/media/clang.mp3');
            clangSoundRef.current.volume = 0.6;
        } catch (e) {
            console.error('Clang sound not found. Place it in /public/assets/media/clang.mp3');
        }

        // --- TIMED SOUND EVENTS ---
        const clangTimer = setTimeout(() => {
            clangSoundRef.current?.play().catch(e => console.warn('Clang sound blocked'));
        }, 1500); // The "Black Out" Start

        const sirenTimer = setTimeout(() => {
            sirenSoundRef.current?.play().catch(e => console.warn('Siren sound autoplay blocked.'));
        }, 1500);

        // --- SEQUENCE COMPLETION ---
        const sequenceTimer = setTimeout(() => {
            setShow(false);
            // Fade out siren sound
            if (sirenSoundRef.current) {
                let vol = sirenSoundRef.current.volume;
                const fadeOut = setInterval(() => {
                    if (vol > 0.05) {
                        vol -= 0.05;
                        sirenSoundRef.current!.volume = vol;
                    } else {
                        sirenSoundRef.current?.pause();
                        clearInterval(fadeOut);
                    }
                }, 100);
            }
            onLoadingComplete();
        }, 10000); // Total duration of the cinematic sequence

        // --- CLEANUP --- 
        return () => {
            clearTimeout(clangTimer);
            clearTimeout(sirenTimer);
            clearTimeout(sequenceTimer);
            sirenSoundRef.current?.pause();
            clangSoundRef.current?.pause();
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

            <div className='film-grain'></div>
            <div className='vignette'></div>
        </div>
    );
};

export default AppLoader;
