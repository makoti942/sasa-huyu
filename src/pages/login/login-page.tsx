import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { startLogin, startSignup } from '@/utils/pkce';
import './login-page.scss';

const LOGO_TEXT = 'MAKOTI TRADERS';

const LoginPage: React.FC = () => {
    const [isLoading, setIsLoading] = useState<'login' | 'signup' | null>(null);

    const handleLogin = async () => {
        if (isLoading) return;
        setIsLoading('login');
        try {
            await startLogin();
        } catch {
            setIsLoading(null);
        }
    };

    const handleSignup = async () => {
        if (isLoading) return;
        setIsLoading('signup');
        try {
            await startSignup();
        } catch {
            setIsLoading(null);
        }
    };

    return (
        <motion.div
            className='login-page'
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
        >
            <div className='login-page__grid' />
            <div className='login-page__glow login-page__glow--red' />
            <div className='login-page__glow login-page__glow--blue' />
            <div className='login-page__scanlines' />
            <div className='login-page__vignette' />

            <div className='login-page__content'>
                <motion.div
                    className='login-page__logo-wrapper'
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2, duration: 0.4 }}
                >
                    <div className='login-page__logo'>
                        {Array.from(LOGO_TEXT).map((char, i) => (
                            <motion.span
                                key={i}
                                className='login-page__logo-letter'
                                initial={{ opacity: 0, y: -28, filter: 'blur(10px)' }}
                                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                                transition={{
                                    delay: 0.35 + i * 0.065,
                                    duration: 0.35,
                                    ease: [0.22, 1, 0.36, 1],
                                }}
                            >
                                {char === ' ' ? '\u00A0' : char}
                            </motion.span>
                        ))}
                    </div>

                    <motion.div
                        className='login-page__divider'
                        initial={{ scaleX: 0, opacity: 0 }}
                        animate={{ scaleX: 1, opacity: 1 }}
                        transition={{ delay: 1.4, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                    />

                    <motion.p
                        className='login-page__subtitle'
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 1.75, duration: 0.5 }}
                    >
                        Professional Deriv Trading Platform
                    </motion.p>

                    <motion.p
                        className='login-page__tagline'
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 2.0, duration: 0.5 }}
                    >
                        ▶&nbsp; Powered by Deriv API v2
                    </motion.p>
                </motion.div>

                <motion.div
                    className='login-page__buttons'
                    initial={{ opacity: 0, y: 36 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 2.2, duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
                >
                    <button
                        className={`login-page__btn login-page__btn--primary${isLoading === 'login' ? ' loading' : ''}`}
                        onClick={handleLogin}
                        disabled={!!isLoading}
                    >
                        {isLoading === 'login' ? (
                            <span className='login-page__spinner' />
                        ) : (
                            <>
                                <span className='login-page__btn-icon'>▶</span>
                                Login to Account
                            </>
                        )}
                    </button>

                    <button
                        className={`login-page__btn login-page__btn--secondary${isLoading === 'signup' ? ' loading' : ''}`}
                        onClick={handleSignup}
                        disabled={!!isLoading}
                    >
                        {isLoading === 'signup' ? (
                            <span className='login-page__spinner' />
                        ) : (
                            <>
                                <span className='login-page__btn-icon'>◯</span>
                                Create New Account
                            </>
                        )}
                    </button>
                </motion.div>

                <motion.p
                    className='login-page__terms'
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 2.65, duration: 0.6 }}
                >
                    By continuing you agree to Deriv&apos;s Terms of Service
                </motion.p>
            </div>
        </motion.div>
    );
};

export default LoginPage;
