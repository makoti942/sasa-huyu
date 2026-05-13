import React, { useEffect, useState } from 'react';
import { handleCallback, startLogin } from '@/utils/auth';
import { Button } from '@deriv-com/ui';

/*
 * CallbackPage — handles /callback after Deriv PKCE login redirect.
 *
 * 1. Detects ?code= in URL → runs handleCallback() from auth.ts
 * 2. On success: stores access_token in sessionStorage + legacy tokens in localStorage,
 *    then redirects to /.
 * 3. On error: shows a clear message + retry button.
 */

type Phase = 'processing' | 'success' | 'error';

const CallbackPage = () => {
    const [phase,    setPhase]    = useState<Phase>('processing');
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);

        // If there is no ?code= or ?error= this is not a PKCE callback —
        // just redirect home so the user doesn't see a blank page.
        if (!params.has('code') && !params.has('error')) {
            window.location.replace('/');
            return;
        }

        handleCallback()
            .then(() => {
                setPhase('success');
                setTimeout(() => {
                    window.location.replace('/');
                }, 1200);
            })
            .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                setErrorMsg(msg);
                setPhase('error');

                // Expired/already-used codes: auto-redirect after a short delay
                if (msg.includes('expired or already used') || msg.includes('single-use')) {
                    setTimeout(() => { window.location.href = '/'; }, 3500);
                }
            });
    }, []);

    if (phase === 'processing') {
        return (
            <div style={styles.container}>
                <p style={styles.muted}>Completing login, please wait…</p>
            </div>
        );
    }

    if (phase === 'success') {
        return (
            <div style={styles.container}>
                <p style={{ color: '#4caf50', fontSize: '16px' }}>
                    Login successful! Redirecting…
                </p>
            </div>
        );
    }

    return (
        <div style={styles.container}>
            <h2 style={{ color: '#e74c3c', marginBottom: '16px' }}>Login failed</h2>
            <pre style={styles.pre}>{errorMsg}</pre>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '20px' }}>
                <Button
                    onClick={() => startLogin().catch(console.error)}
                    primary
                >
                    Try Again
                </Button>
                <Button
                    onClick={() => { window.location.href = '/'; }}
                    tertiary
                >
                    Return to App
                </Button>
            </div>
        </div>
    );
};

const styles: Record<string, React.CSSProperties> = {
    container: {
        padding:    '40px 24px',
        textAlign:  'center',
        maxWidth:   '520px',
        margin:     '60px auto',
        color:      '#fff',
    },
    muted: {
        color:      '#aaa',
        fontSize:   '15px',
    },
    pre: {
        color:           '#ccc',
        background:      '#1a1a1a',
        padding:         '12px 16px',
        borderRadius:    '8px',
        fontSize:        '13px',
        fontFamily:      'monospace',
        textAlign:       'left',
        whiteSpace:      'pre-wrap',
        overflowWrap:    'break-word',
        margin:          '0 auto',
        maxWidth:        '480px',
    },
};

export default CallbackPage;
