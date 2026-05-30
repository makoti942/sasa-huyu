import React, { useEffect, useRef, useState } from 'react';
import { Scanner } from './scanner';
import { MarketKiller } from './market-killer';
import './makoti-widget.scss';

type Tab = 'scanner' | 'market_killer';
const PAD = 8;

export const MakotiWidget: React.FC = () => {
    const [open, setOpen]         = useState(() => localStorage.getItem('mw_open') === 'true');
    const [tab, setTab]           = useState<Tab>(() => (localStorage.getItem('mw_tab') as Tab) || 'scanner');
    const [minimized, setMinimized] = useState(false);

    /* ── FAB position (refs for zero-rerender drag) ─────────── */
    const btnPosRef = useRef({ x: Math.max(PAD, window.innerWidth - 88), y: Math.max(PAD, window.innerHeight - 108) });
    const winPosRef = useRef({ x: Math.max(PAD, window.innerWidth - 420), y: Math.max(PAD, window.innerHeight - 640) });

    /* ── Persist open / tab state to localStorage ─────────── */
    useEffect(() => { localStorage.setItem('mw_open', String(open)); }, [open]);
    useEffect(() => { localStorage.setItem('mw_tab',  tab);          }, [tab]);

    /* ── Drag state (refs, never cause re-renders) ─────────── */
    const btnDragging  = useRef(false);
    const winDragging  = useRef(false);
    const btnMoved     = useRef(false);
    const winMoved     = useRef(false);
    const startClient  = useRef({ x: 0, y: 0 });
    const startElem    = useRef({ x: 0, y: 0 });
    const rafId        = useRef<number | null>(null);

    const btnRef = useRef<HTMLButtonElement>(null);
    const winRef = useRef<HTMLDivElement>(null);

    /* ── Shared global pointer handlers (RAF-based for smooth drag) ── */
    useEffect(() => {
        let pendingDx = 0, pendingDy = 0;
        let hasPending = false;

        const w = window.innerWidth;
        const h = window.innerHeight;
        const winW = Math.min(400, w - PAD * 2);
        const winH = Math.min(620, h - 80);

        const applyDrag = () => {
            rafId.current = null;
            if (btnDragging.current && btnRef.current) {
                const nx = Math.max(PAD, Math.min(w - 72 - PAD, startElem.current.x + pendingDx));
                const ny = Math.max(PAD, Math.min(h - 72 - PAD, startElem.current.y + pendingDy));
                btnRef.current.style.left = nx + 'px';
                btnRef.current.style.top  = ny + 'px';
                btnPosRef.current = { x: nx, y: ny };
            }
            if (winDragging.current && winRef.current) {
                const nx = Math.max(PAD, Math.min(w - winW - PAD, startElem.current.x + pendingDx));
                const ny = Math.max(PAD, Math.min(h - 60,        startElem.current.y + pendingDy));
                winRef.current.style.left = nx + 'px';
                winRef.current.style.top  = ny + 'px';
                winPosRef.current = { x: nx, y: ny };
            }
            hasPending = false;
        };

        const onMove = (e: PointerEvent) => {
            if (!btnDragging.current && !winDragging.current) return;
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
            btnDragging.current = false;
            winDragging.current = false;
            if (rafId.current !== null) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
            }
        };

        document.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerup',   onUp);
        return () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup',   onUp);
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
            const defX = Math.max(PAD, w - Math.min(400, w - PAD * 2) - PAD);
            const defY = Math.max(PAD, h - 640);
            winRef.current.style.left = (w <= 600 ? PAD : defX) + 'px';
            winRef.current.style.top  = (w <= 600 ? PAD : defY) + 'px';
        }
    }, [open]);

    /* ── FAB pointer down ─────────────────────────────────── */
    const onBtnPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        e.preventDefault();
        btnDragging.current = true;
        btnMoved.current    = false;
        startClient.current = { x: e.clientX, y: e.clientY };
        startElem.current   = { ...btnPosRef.current };
        btnRef.current?.setPointerCapture(e.pointerId);
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
        winRef.current?.setPointerCapture(e.pointerId);
    };

    /* ── Window initial position (computed inline, no flash) ── */
    const initWinStyle = (() => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (w <= 600) return { left: PAD, top: PAD };
        return {
            left: Math.max(PAD, w - Math.min(400, w - PAD * 2) - PAD),
            top: Math.max(PAD, h - 640),
        };
    })();

    return (
        <>
            {/* ── Floating button ── */}
            <button
                ref={btnRef}
                className={`mw-fab${open ? ' mw-fab--open' : ''}`}
                style={{ position: 'fixed', left: btnPosRef.current.x, top: btnPosRef.current.y, zIndex: 100001 }}
                onPointerDown={onBtnPointerDown}
                onClick={onBtnClick}
                title='MAKOTI — Scanner & Market Killer'
            >
                <span className='mw-fab__pulse' />
                <span className='mw-fab__icon'>⚔</span>
                <span className='mw-fab__label'>MAKOTI</span>
            </button>

            {/* ── Floating window (draggable, same on all devices) ── */}
            {open && (
                <div
                    ref={winRef}
                    className={`mw-window${minimized ? ' mw-window--min' : ''}`}
                    style={{ position: 'fixed', left: initWinStyle.left + 'px', top: initWinStyle.top + 'px' }}
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
                                title={minimized ? 'Expand' : 'Minimize'}
                            >
                                {minimized ? '▲' : '▼'}
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

                    {/* Content always mounted (keeps WS/interval alive), just hidden when minimized */}
                    <div className='mw-tabs' style={minimized ? { display: 'none' } : undefined}>
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
                    </div>

                    <div className='mw-win-body' style={minimized ? { display: 'none' } : undefined}>
                        {tab === 'scanner' ? <Scanner /> : <MarketKiller />}
                    </div>
                </div>
            )}
        </>
    );
};

export default MakotiWidget;
