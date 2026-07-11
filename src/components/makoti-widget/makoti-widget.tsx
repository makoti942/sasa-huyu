import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Scanner } from './scanner';
import { MarketKiller } from './market-killer';
import { OverUnderKiller } from './over-under-killer';
import { Under7 } from './under-7';
import './makoti-widget.scss';

type Tab = 'scanner' | 'market_killer' | 'over_under' | 'under_7';
const PAD = 8;

function isLoggedIn(): boolean {
    try {
        const loggedState = document.cookie.includes('logged_state=true');
        const accountsList = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
        return loggedState || Object.keys(accountsList).length > 0;
    } catch { return false; }
}

export const MakotiWidget: React.FC = () => {
    const [open, setOpen]         = useState(() => localStorage.getItem('mw_open') === 'true');
    const [tab, setTab]           = useState<Tab>(() => (localStorage.getItem('mw_tab') as Tab) || 'scanner');
    const [minimized, setMinimized] = useState(false);
    const [loggedIn, setLoggedIn] = useState(isLoggedIn());

    useEffect(() => {
        const check = () => setLoggedIn(isLoggedIn());
        const interval = setInterval(check, 1000);
        window.addEventListener('storage', check);
        return () => { clearInterval(interval); window.removeEventListener('storage', check); };
    }, []);

    if (!loggedIn) return null;

    /* ── FAB position (refs for zero-rerender drag) ─────────── */
    const btnPosRef = useRef({ x: Math.max(PAD, window.innerWidth - 88), y: Math.max(PAD, window.innerHeight - 108) });
    const winPosRef = useRef({ x: Math.max(PAD, window.innerWidth - 420), y: Math.max(PAD, window.innerHeight - 640) });

    /* ── Expose programmatic tab switching for Recovery Mode ── */
    const switchToTab = useCallback((t: Tab) => {
        setTab(t);
        localStorage.setItem('mw_tab', t);
    }, []);

    useEffect(() => {
        window.DBot = window.DBot || {};
        window.DBot.__switchToTab = switchToTab;
        return () => { if (window.DBot) delete window.DBot.__switchToTab; };
    }, [switchToTab]);

    /* ── Persist open / tab state to localStorage ─────────── */
    useEffect(() => { localStorage.setItem('mw_open', String(open)); }, [open]);
    useEffect(() => { localStorage.setItem('mw_tab',  tab);          }, [tab]);

    /* ── Drag state (refs, never cause re-renders) ─────────── */
    const btnDragging  = useRef(false);
    const winDragging  = useRef(false);
    const miniDragging = useRef(false);
    const btnMoved     = useRef(false);
    const winMoved     = useRef(false);
    const startClient  = useRef({ x: 0, y: 0 });
    const startElem    = useRef({ x: 0, y: 0 });
    const rafId        = useRef<number | null>(null);

    const btnRef  = useRef<HTMLButtonElement>(null);
    const winRef  = useRef<HTMLDivElement>(null);
    const miniRef = useRef<HTMLButtonElement>(null);

    /* ── Shared global pointer handlers (transform-based for GPU-composited drag) ── */
    useEffect(() => {
        let pendingDx = 0, pendingDy = 0;
        let hasPending = false;

        const w = window.innerWidth;
        const h = window.innerHeight;
        const isMobile = w <= 600;
        const winW = Math.min(isMobile ? 250 : 300, w - PAD * 2);

        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

        const applyDrag = () => {
            rafId.current = null;

            if (btnDragging.current && btnRef.current) {
                const baseX = startElem.current.x;
                const baseY = startElem.current.y;
                const nx = clamp(baseX + pendingDx, PAD, w - 72 - PAD);
                const ny = clamp(baseY + pendingDy, PAD, h - 72 - PAD);
                btnRef.current.style.transform = `translate(${nx - baseX}px, ${ny - baseY}px)`;
                btnPosRef.current = { x: nx, y: ny };
            }
            if (winDragging.current && winRef.current) {
                const baseX = startElem.current.x;
                const baseY = startElem.current.y;
                const nx = clamp(baseX + pendingDx, PAD, w - winW - PAD);
                const ny = clamp(baseY + pendingDy, PAD, h - 60);
                winRef.current.style.transform = `translate(${nx - baseX}px, ${ny - baseY}px)`;
                winPosRef.current = { x: nx, y: ny };
            }
            if (miniDragging.current && miniRef.current) {
                const baseX = startElem.current.x;
                const baseY = startElem.current.y;
                const nx = clamp(baseX + pendingDx, PAD, w - 44 - PAD);
                const ny = clamp(baseY + pendingDy, PAD, h - 44 - PAD);
                miniRef.current.style.transform = `translate(${nx - baseX}px, ${ny - baseY}px)`;
                winPosRef.current = { x: nx, y: ny };
            }
            hasPending = false;
        };

        const onMove = (e: PointerEvent) => {
            if (!btnDragging.current && !winDragging.current && !miniDragging.current) return;
            const dx = e.clientX - startClient.current.x;
            const dy = e.clientY - startClient.current.y;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                btnMoved.current = true;
                winMoved.current = true;
            }
            pendingDx = dx;
            pendingDy = dy;
            if (!hasPending) {
                hasPending = true;
                rafId.current = requestAnimationFrame(applyDrag);
            }
        };

        const onUp = () => {
            const wasBtn  = btnDragging.current;
            const wasWin  = winDragging.current;
            const wasMini = miniDragging.current;

            btnDragging.current  = false;
            winDragging.current  = false;
            miniDragging.current = false;
            hasPending = false;

            if (rafId.current !== null) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
            }

            if (wasBtn && btnRef.current) {
                btnRef.current.style.left = btnPosRef.current.x + 'px';
                btnRef.current.style.top  = btnPosRef.current.y + 'px';
                btnRef.current.style.transform = 'none';
                btnRef.current.style.transition = '';
            }
            if (wasWin && winRef.current) {
                winRef.current.style.transform = 'none';
                winRef.current.style.left = winPosRef.current.x + 'px';
                winRef.current.style.top  = winPosRef.current.y + 'px';
            }
            if (wasMini && miniRef.current) {
                miniRef.current.style.left = winPosRef.current.x + 'px';
                miniRef.current.style.top  = winPosRef.current.y + 'px';
                miniRef.current.style.transform = 'none';
                miniRef.current.style.transition = '';
            }
        };

        const onCancel = () => { if (btnDragging.current || winDragging.current || miniDragging.current) onUp(); };

        document.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerup',   onUp);
        document.addEventListener('pointercancel', onCancel);
        document.addEventListener('pointerleave', onCancel);
        return () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup',   onUp);
            document.removeEventListener('pointercancel', onCancel);
            document.removeEventListener('pointerleave', onCancel);
            if (rafId.current !== null) cancelAnimationFrame(rafId.current);
        };
    }, []);

    /* ── Set initial positions via refs on first render ─────── */
    useEffect(() => {
        if (btnRef.current) {
            btnRef.current.style.left = btnPosRef.current.x + 'px';
            btnRef.current.style.top  = btnPosRef.current.y + 'px';
        }
    }, []);

    useEffect(() => {
        if (winRef.current && open) {
            const w = window.innerWidth;
            const h = window.innerHeight;
            const isMob = w <= 600;
            const defX = Math.max(PAD, w - Math.min(isMob ? 250 : 300, w - PAD * 2) - PAD);
            const defY = Math.max(PAD, h - (isMob ? 380 : 460));
            const nx = isMob ? PAD : defX;
            const ny = w <= 600 ? PAD : defY;
            winRef.current.style.left = nx + 'px';
            winRef.current.style.top  = ny + 'px';
            winPosRef.current = { x: nx, y: ny };
        }
    }, [open]);

    /* ── FAB pointer down ─────────────────────────────────── */
    const onBtnPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        btnDragging.current = true;
        btnMoved.current    = false;
        startClient.current = { x: e.clientX, y: e.clientY };
        startElem.current   = { ...btnPosRef.current };
        if (btnRef.current) btnRef.current.style.transition = 'none';
    };

    /* ── FAB click — only toggle if not a drag ────────────── */
    const onBtnClick = () => {
        if (btnMoved.current) { btnMoved.current = false; return; }
        setOpen(o => !o);
    };

    /* ── Window header pointer down ───────────────────────── */
    const onWinPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (
            target.closest('.mw-win-body')    ||
            target.closest('.mw-win-actions') ||
            target.closest('.mw-tabs')        ||
            target.tagName === 'BUTTON' ||
            target.tagName === 'INPUT'  ||
            target.tagName === 'SELECT'
        ) return;
        e.preventDefault();
        winDragging.current = true;
        winMoved.current    = false;
        startClient.current = { x: e.clientX, y: e.clientY };
        startElem.current   = { ...winPosRef.current };
    };

    return (
        <>
            {/* ── Floating button ── */}
            <button
                ref={btnRef}
                className={`mw-fab${open ? ' mw-fab--open' : ''}`}
                style={{ position: 'fixed', left: btnPosRef.current.x, top: btnPosRef.current.y, zIndex: 100001 }}
                onPointerDown={onBtnPointerDown}
                onClick={onBtnClick}
                title='MAKOTI — Scanner / Market Killer / O/U / Under 7'
            >
                <span className='mw-fab__pulse' />
                <span className='mw-fab__icon'>⚔</span>
                <span className='mw-fab__label'>MAKOTI</span>
            </button>

            {/* ── Floating window & tab content (always mounted so active killer survives close) ── */}
            <div
                ref={winRef}
                className={`mw-window${open ? '' : ' mw-window--closed'}${minimized ? ' mw-window--hidden' : ''}`}
                style={{ position: 'fixed', left: winPosRef.current.x + 'px', top: winPosRef.current.y + 'px' }}
                onPointerDown={onWinPointerDown}
            >
                <div className='mw-win-header'>
                    <div className='mw-win-title'>
                        <span className='mw-win-logo'>⚔</span>
                        <span>MAKOTI</span>
                    </div>
                    <div className='mw-win-actions'>
                        <button
                            className='mw-win-action'
                            onClick={() => setMinimized(m => !m)}
                            title='Minimize'
                        >
                            ▼
                        </button>
                        <button
                            className='mw-win-action mw-win-action--close'
                            onClick={() => setOpen(false)}
                            title='Close'
                        >
                            ×
                        </button>
                    </div>
                </div>

                <div className='mw-tabs'>
                    <button
                        className={`mw-tab${tab === 'scanner' ? ' mw-tab--active' : ''}`}
                        onClick={() => setTab('scanner')}
                    >
                        Scanner
                    </button>
                    <button
                        className={`mw-tab${tab === 'market_killer' ? ' mw-tab--active' : ''}`}
                        onClick={() => setTab('market_killer')}
                    >
                        Market Killer
                    </button>
                    <button
                        className={`mw-tab${tab === 'over_under' ? ' mw-tab--active' : ''}`}
                        onClick={() => setTab('over_under')}
                    >
                        O/U Killer
                    </button>
                    <button
                        className={`mw-tab${tab === 'under_7' ? ' mw-tab--active' : ''}`}
                        onClick={() => setTab('under_7')}
                    >
                        Under 7
                    </button>
                </div>

                <div className='mw-win-body'>
                    {tab === 'scanner' && <Scanner />}
                    {tab === 'market_killer' && <MarketKiller />}
                    {tab === 'over_under' && <OverUnderKiller />}
                    {tab === 'under_7' && <Under7 />}
                </div>
            </div>

            {open && minimized && (
                <button
                    ref={miniRef}
                    className='mw-mini'
                    style={{
                        position: 'fixed',
                        left: winPosRef.current.x,
                        top: winPosRef.current.y,
                        zIndex: 99998,
                    }}
                    onPointerDown={(e) => {
                        miniDragging.current = true;
                        winMoved.current = false;
                        startClient.current = { x: e.clientX, y: e.clientY };
                        startElem.current = { ...winPosRef.current };
                        if (miniRef.current) miniRef.current.style.transition = 'none';
                        e.preventDefault();
                    }}
                    onClick={() => {
                        if (winMoved.current) { winMoved.current = false; return; }
                        setMinimized(false);
                    }}
                >
                    ⚔
                </button>
            )}
        </>
    );
};

export default MakotiWidget;
