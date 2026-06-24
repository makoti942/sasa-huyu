import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { generateOAuthURL } from '@/components/shared';
import { startNewLogin, startNewSignup } from '@/auth/NewDerivAuth';
import useTMB from '@/hooks/useTMB';
import './LoginScreen.scss';

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
            <div className='login-screen__bg' style={{ backgroundImage: "url('/makoti-logo.jpg')" }} />
            <div className='login-screen__overlay' />

            <div className='login-screen__content'>
                <div className='login-screen__logo-wrap'>
                    <img src='/makoti-logo.jpg' alt='Makoti Traders' className='login-screen__logo' />
                </div>

                <div className='login-screen__brand'>
                    <h1 className='login-screen__title'>MAKOTI TRADERS</h1>
                    <p className='login-screen__sub'>POWERED BY DERIV</p>
                </div>

                <p className='login-screen__tagline'>
                    Your intelligent trading platform.<br />
                    Automate strategies. Trade smarter.
                </p>

                <div className='login-screen__buttons'>
                    <button
                        className='login-screen__btn login-screen__btn--primary'
                        onClick={handleStandardLogin}
                        disabled
                    >
                        <span className='login-screen__btn-icon'>→</span>
                        Log In
                    </button>

                    <button
                        className={`login-screen__btn login-screen__btn--secondary${isNewLoginLoading ? ' login-screen__btn--loading' : ''}`}
                        onClick={handleNewAccountsLogin}
                        disabled={isNewLoginLoading}
                    >
                        <span className='login-screen__btn-icon'>✦</span>
                        {isNewLoginLoading ? 'Preparing…' : 'Login (New Accounts)'}
                    </button>
                </div>

                {newLoginError && (
                    <p className='login-screen__error'>{newLoginError}</p>
                )}

                <div className='login-screen__divider'>
                    <span>or</span>
                </div>

                <div className='login-screen__create-wrap'>
                    <button
                        className='login-screen__btn login-screen__btn--create'
                        onClick={startNewSignup}
                    >
                        <span className='login-screen__btn-icon'>+</span>
                        Create Account
                    </button>
                </div>

                <p className='login-screen__footer-note'>
                    Secure login powered by Deriv OAuth
                </p>
            </div>

            <div className='login-screen__particles'>
                {[...Array(12)].map((_, i) => (
                    <div key={i} className={`login-screen__particle login-screen__particle--${i + 1}`} />
                ))}
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
