import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { generateOAuthURL } from '@/components/shared';
import { startNewLogin, startNewSignup } from '@/auth/NewDerivAuth';
import useTMB from '@/hooks/useTMB';
import './LoginScreen.scss';

const FLOATING_ICONS = ['✦', '◆', '⬡', '●', '★', '⟡', '◆', '✦', '⬡', '◈', '▣', '◇'];
const SPARKLES = 30;

const LoginScreenInner = () => {
    const [isNewLoginLoading, setIsNewLoginLoading] = useState(false);
    const [newLoginError, setNewLoginError] = useState('');
    const [visible, setVisible] = useState(false);
    const { onRenderTMBCheck, isTmbEnabled } = useTMB();

    useEffect(() => {
        const t = setTimeout(() => setVisible(true), 80);
        return () => clearTimeout(t);
    }, []);

    const handleStandardLogin = async () => {
        try {
            const tmbEnabled = await isTmbEnabled();
            if (tmbEnabled) {
                await onRenderTMBCheck(true, undefined, false);
            } else {
                window.location.href = generateOAuthURL(false, 'home');
            }
        } catch (error) {
            console.error(error);
        }
    };

    const handleNewAccountsLogin = async (e: React.MouseEvent) => {
        e.preventDefault();
        if (isNewLoginLoading) return;
        setIsNewLoginLoading(true);
        setNewLoginError('');
        try {
            await startNewLogin();
            setIsNewLoginLoading(false);
        } catch (error) {
            console.error('[New Accounts Login]', error);
            setIsNewLoginLoading(false);
            setNewLoginError('Login failed to start. Please try again or use a different browser.');
        }
    };

    return (
        <div className={`login-screen${visible ? ' login-screen--visible' : ''}`}>
            <div className='login-screen__bg'>
                <div className='login-screen__bg-orbs'>
                    <div className='login-screen__orb login-screen__orb--1' />
                    <div className='login-screen__orb login-screen__orb--2' />
                    <div className='login-screen__orb login-screen__orb--3' />
                    <div className='login-screen__orb login-screen__orb--4' />
                </div>
            </div>

            <div className='login-screen__grid' />

            <div className='login-screen__floating-icons'>
                {FLOATING_ICONS.map((icon, i) => (
                    <span key={i} className='login-screen__float-icon' style={{
                        left: `${(i * 7.7 + 2) % 92}%`,
                        animationDelay: `${i * 1.4}s`,
                        animationDuration: `${16 + (i % 6) * 4}s`,
                        fontSize: `${1 + (i % 5) * 0.6}rem`,
                        opacity: 0.04 + (i % 3) * 0.02,
                    }}>{icon}</span>
                ))}
            </div>

            {[...Array(SPARKLES)].map((_, i) => (
                <div key={i} className='login-screen__sparkle' style={{
                    left: `${(i * 4.1 + 1) % 100}%`,
                    top: `${(i * 6.3 + 3) % 100}%`,
                    animationDelay: `${i * 0.5}s`,
                    animationDuration: `${2.5 + (i % 5) * 1.8}s`,
                    width: `${2 + (i % 3)}px`,
                    height: `${2 + (i % 3)}px`,
                }} />
            ))}

            <div className='login-screen__top-glow' />

            <div className='login-screen__header'>
                <div className='login-screen__logo-wrap'>
                    <div className='login-screen__logo-ring' />
                    <img src='/makoti-logo.jpg' alt='Makoti Traders' className='login-screen__logo' />
                </div>
                <div className='login-screen__brand'>
                    <h1 className='login-screen__title'>MAKOTI TRADERS</h1>
                    <p className='login-screen__sub'>POWERED BY DERIV</p>
                </div>
            </div>

            <div className='login-screen__center'>
                <p className='login-screen__tagline'>
                    Your intelligent trading platform.<br />
                    Automate strategies. Trade smarter.
                </p>

                <button
                    className={`login-screen__btn login-screen__btn--login${isNewLoginLoading ? ' login-screen__btn--loading' : ''}`}
                    onClick={handleNewAccountsLogin}
                    disabled={isNewLoginLoading}
                >
                    <span className='login-screen__btn-shimmer' />
                    <span className='login-screen__btn-icon'>✦</span>
                    <span className='login-screen__btn-text'>{isNewLoginLoading ? 'Preparing…' : 'Login (New Accounts)'}</span>
                </button>

                {newLoginError && (
                    <p className='login-screen__error'>{newLoginError}</p>
                )}

                <div className='login-screen__divider'>
                    <span>or</span>
                </div>

                <button
                    className='login-screen__btn login-screen__btn--create'
                    onClick={startNewSignup}
                >
                    <span className='login-screen__btn-icon'>+</span>
                    <span className='login-screen__btn-text'>Create Account</span>
                </button>
            </div>

            <div className='login-screen__footer'>
                <div className='login-screen__footer-info'>
                    <span className='login-screen__footer-label'>Developed by</span>
                    <span className='login-screen__footer-value'>Makoti Developers</span>
                </div>
                <div className='login-screen__footer-info'>
                    <span className='login-screen__footer-label'>Contact</span>
                    <span className='login-screen__footer-value'>makotitraders@proton.me</span>
                </div>
                <div className='login-screen__footer-info'>
                    <span className='login-screen__footer-label'>Version</span>
                    <span className='login-screen__footer-value'>2.0.0</span>
                </div>
                <p className='login-screen__footer-note'>Secure login powered by Deriv OAuth</p>
            </div>
        </div>
    );
};

const LoginScreen = () => {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        return () => setMounted(false);
    }, []);

    if (!mounted) return null;

    return ReactDOM.createPortal(<LoginScreenInner />, document.body);
};

export default LoginScreen;
