import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './app-loader.scss';

interface AppLoaderProps {
    onLoadingComplete: () => void;
    duration?: number;
}

const SUBTITLES = [
    'INITIALIZING PLATFORM',
    'LOADING MARKET DATA',
    'CONFIGURING MODULES',
    'ALMOST READY',
];

const AppLoader: React.FC<AppLoaderProps> = ({ onLoadingComplete, duration = 5000 }) => {
    const [show, setShow] = useState(true);
    const [subIndex, setSubIndex] = useState(0);

    useEffect(() => {
        const subInterval = setInterval(() => {
            setSubIndex(prev => Math.min(prev + 1, SUBTITLES.length - 1));
        }, duration / SUBTITLES.length);

        const timer = setTimeout(() => {
            setShow(false);
            onLoadingComplete();
        }, duration);

        return () => {
            clearTimeout(timer);
            clearInterval(subInterval);
        };
    }, [onLoadingComplete, duration]);

    if (!show) return null;

    return (
        <div className='app-loader'>
            <div className='loader-bg'>
                <div className='orb orb--1' />
                <div className='orb orb--2' />
                <div className='orb orb--3' />
            </div>

            <div className='loader-content'>
                <motion.div
                    className='logo-mark'
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                >
                    <svg width='48' height='48' viewBox='0 0 48 48' fill='none'>
                        <defs>
                            <linearGradient id='logoGrad' x1='0' y1='0' x2='1' y2='1'>
                                <stop offset='0%' stopColor='#85acb0' />
                                <stop offset='100%' stopColor='#ffa500' />
                            </linearGradient>
                        </defs>
                        <path
                            d='M24 2L46 24L24 46L2 24L24 2Z'
                            stroke='url(#logoGrad)'
                            strokeWidth='2'
                            fill='none'
                        />
                        <path
                            d='M24 10L38 24L24 38L10 24L24 10Z'
                            stroke='url(#logoGrad)'
                            strokeWidth='1.5'
                            fill='none'
                            opacity='0.5'
                        />
                        <circle cx='24' cy='24' r='4' fill='#85acb0' />
                    </svg>
                </motion.div>

                <motion.h1
                    className='loader-title'
                    initial={{ y: 30, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.6, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
                >
                    MAKOTI TRADERS
                </motion.h1>

                <motion.p
                    className='loader-subtitle'
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.6, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
                >
                    TRADING PLATFORM
                </motion.p>

                <motion.div
                    className='loader-bar-container'
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.6, delay: 0.55 }}
                >
                    <div className='loader-bar'>
                        <div className='loader-bar-fill' style={{ animationDuration: `${duration}ms` }} />
                    </div>
                </motion.div>

                <div className='loader-status-container'>
                    <AnimatePresence mode='wait'>
                        <motion.p
                            key={subIndex}
                            className='loader-status'
                            initial={{ y: 12, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ y: -12, opacity: 0 }}
                            transition={{ duration: 0.25 }}
                        >
                            {SUBTITLES[subIndex]}
                        </motion.p>
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
};

export default AppLoader;
