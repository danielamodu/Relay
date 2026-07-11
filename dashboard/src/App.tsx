import { useState, useEffect } from 'react';

interface AgentStatus {
  id: string;
  name: string;
  serviceId: string;
  status: 'ONLINE' | 'ACTIVE' | 'IDLE' | 'OFFLINE';
  lastActive: string | null;
}

interface ActiveFlow {
  orderId: string;
  stage: 'negotiating' | 'accepted' | 'paid' | 'upstream_negotiating' | 'upstream_paid' | 'translating' | 'delivering' | 'completed' | 'failed';
  timestamp: string;
  sourceFormat: string;
  targetFormat: string;
  itemId: string;
  dryRun: boolean;
}

interface Transaction {
  orderId: string;
  stage: string;
  timestamp: string;
  sourceFormat: string;
  targetFormat: string;
  itemId: string;
  dryRun: boolean;
  receipt?: {
    input_payload_hash: string;
    output_payload_hash: string;
    timestamp: string;
  };
  error?: string;
}

interface CompatibilityEntry {
  source_agent_id: string;
  target_agent_id: string;
  source_format: string;
  target_format: string;
  service_id: string;
}

const DEFAULT_JSON = `{
  "item_id": "inv-1001",
  "name": "Core Socket Wrench",
  "stock_quantity": 150,
  "unit_price": 12.50
}`;

const DEFAULT_XML = `<PricingQuote>
  <ItemID>inv-1001</ItemID>
  <Name>Core Socket Wrench</Name>
  <Quantity>150</Quantity>
  <UnitPrice>12.50</UnitPrice>
  <TotalPrice>1875.00</TotalPrice>
</PricingQuote>`;

const API_BASE = 'http://localhost:3001';

function App() {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [activeFlows, setActiveFlows] = useState<ActiveFlow[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [registry, setRegistry] = useState<CompatibilityEntry[]>([]);

  // Playground Form State
  const [sourceFormat, setSourceFormat] = useState<'json' | 'xml'>('json');
  const [targetFormat, setTargetFormat] = useState<'json' | 'xml'>('xml');
  const [payload, setPayload] = useState(DEFAULT_JSON);
  const [prune, setPrune] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationResult, setTranslationResult] = useState<string | null>(null);
  const [translationReceipt, setTranslationReceipt] = useState<any | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sync default payload when changing sourceFormat
  const handleSourceFormatChange = (fmt: 'json' | 'xml') => {
    setSourceFormat(fmt);
    setTargetFormat(fmt === 'json' ? 'xml' : 'json');
    setPayload(fmt === 'json' ? DEFAULT_JSON : DEFAULT_XML);
  };

  // Poll status & transactions
  useEffect(() => {
    const fetchData = async () => {
      try {
        const resStatus = await fetch(`${API_BASE}/api/status`);
        if (resStatus.ok) {
          const data = await resStatus.json();
          setAgents(data.agents || []);
          setActiveFlows(data.activeFlows || []);
        }

        const resTx = await fetch(`${API_BASE}/api/transactions`);
        if (resTx.ok) {
          const txs = await resTx.json();
          setTransactions(txs || []);
        }

        const resReg = await fetch(`${API_BASE}/api/registry`);
        if (resReg.ok) {
          const reg = await resReg.json();
          setRegistry(reg || []);
        }
      } catch (err) {
        console.warn('API polling error (agent server may not be running yet):', err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, []);

  const triggerTestTranslation = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsTranslating(true);
    setErrorMsg(null);
    setTranslationResult(null);
    setTranslationReceipt(null);

    try {
      const response = await fetch(`${API_BASE}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload,
          sourceFormat,
          targetFormat,
          prune
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to translate');
      }

      const result = await response.json();
      setTranslationResult(result.translated);
      setTranslationReceipt(result.receipt);
    } catch (err: any) {
      setErrorMsg(err.message || 'An unexpected error occurred');
    } finally {
      setIsTranslating(false);
    }
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'ONLINE': return 'status-indicator online';
      case 'ACTIVE': return 'status-indicator active';
      case 'IDLE': return 'status-indicator idle';
      default: return 'status-indicator offline';
    }
  };

  return (
    <div className="app-container">
      <header>
        <div className="brand-section">
          <div className="logo-container">
            <img src="/logo.png" alt="Relay" width="48" height="48" />
          </div>
          <div className="brand-info">
            <h1>Cooperative Agent Network</h1>
            <p>Relay translation & compatibility node</p>
          </div>
        </div>
        <div className="header-meta">
          <div>NODE ID: RELAY-MAIN-1</div>
          <div style={{ color: 'var(--text-muted)' }}>PORT: 3001</div>
        </div>
      </header>

      <div className="dashboard-grid">
        <main className="main-content">
          {/* Active Agents Row */}
          <div>
            <div className="section-title">Connected Network Nodes</div>
            <div className="agents-row">
              {agents.length > 0 ? (
                agents.map((agent) => (
                  <div key={agent.id} className="agent-card">
                    <div className="agent-header">
                      <span className="agent-name">{agent.name}</span>
                      <span className="agent-status-tag">
                        <span className={getStatusClass(agent.status)}></span>
                        {agent.status}
                      </span>
                    </div>
                    <div className="agent-service-id">
                      Service: {agent.serviceId}
                    </div>
                    <div className="agent-activity">
                      Last Active: {agent.lastActive ? new Date(agent.lastActive).toLocaleTimeString() : 'N/A'}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ gridColumn: 'span 3', textAlign: 'center', padding: '24px', border: '1px dashed var(--border)' }}>
                  <p className="empty-text">No active nodes detected. Ensure backend provider.ts is running.</p>
                </div>
              )}
            </div>
          </div>

          {/* Active Flow Transactions */}
          <div>
            <div className="section-title">
              Live CAP Flow Monitors
              <span className="section-subtitle">{activeFlows.length} processing</span>
            </div>
            <div className="table-container">
              {activeFlows.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th>Order ID</th>
                      <th>Item</th>
                      <th>Flow Direction</th>
                      <th>Dry Run</th>
                      <th>Stage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeFlows.map((flow) => (
                      <tr key={flow.orderId}>
                        <td className="mono-cell">{flow.orderId.substring(0, 16)}...</td>
                        <td className="mono-cell">{flow.itemId}</td>
                        <td className="mono-cell">{flow.sourceFormat.toUpperCase()} &rarr; {flow.targetFormat.toUpperCase()}</td>
                        <td className="mono-cell">{flow.dryRun ? 'TRUE' : 'FALSE'}</td>
                        <td>
                          <span className="flow-badge">{flow.stage}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty-text">No active translation negotiations in pipeline</div>
              )}
            </div>
          </div>

          {/* Completed Transaction Logs */}
          <div>
            <div className="section-title">Verified Transaction Ledger</div>
            <div className="table-container">
              {transactions.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Order ID</th>
                      <th>Item ID</th>
                      <th>Conversion</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx, idx) => (
                      <tr key={idx}>
                        <td className="mono-cell">{new Date(tx.timestamp).toLocaleTimeString()}</td>
                        <td className="mono-cell">{tx.orderId.substring(0, 16)}...</td>
                        <td className="mono-cell">{tx.itemId}</td>
                        <td className="mono-cell">{tx.sourceFormat.toUpperCase()} &rarr; {tx.targetFormat.toUpperCase()}</td>
                        <td>
                          <span className={`flow-badge ${tx.stage}`}>
                            {tx.stage}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty-text">Ledger empty. Execute a translation to log verification receipts.</div>
              )}
            </div>
          </div>
        </main>

        <aside className="sidebar">
          {/* Playground Playground */}
          <div>
            <div className="section-title">Test Translation Playground</div>
            <form onSubmit={triggerTestTranslation} className="playground-box">
              <div className="select-row">
                <div className="form-group">
                  <label>Source Format</label>
                  <select
                    value={sourceFormat}
                    onChange={(e) => handleSourceFormatChange(e.target.value as 'json' | 'xml')}
                  >
                    <option value="json">JSON</option>
                    <option value="xml">XML</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Target Format</label>
                  <select
                    value={targetFormat}
                    onChange={(e) => {
                      setTargetFormat(e.target.value as 'json' | 'xml');
                      setSourceFormat(e.target.value === 'json' ? 'xml' : 'json');
                    }}
                  >
                    <option value="json">JSON</option>
                    <option value="xml">XML</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Input Payload</label>
                <textarea
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  placeholder="Paste payload here..."
                />
              </div>

              <div className="form-group checkbox-group">
                <input
                  type="checkbox"
                  id="prune-toggle"
                  checked={prune}
                  onChange={(e) => setPrune(e.target.checked)}
                />
                <label htmlFor="prune-toggle">Compact Context (Prune keys & comments)</label>
              </div>

              <button
                type="submit"
                className="stark-btn"
                disabled={isTranslating || !payload}
              >
                {isTranslating ? 'Translating...' : 'Trigger Translation'}
              </button>
            </form>
          </div>

          {/* Translation Result Panel */}
          {(translationResult || translationReceipt || errorMsg) && (
            <div className="result-box">
              <div className="section-title">Translation Result</div>
              
              {errorMsg && (
                <div style={{ padding: '16px', border: '1px dashed var(--text)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '12px' }}>
                  [ERROR]: {errorMsg}
                </div>
              )}

              {translationResult && (
                <div className="form-group">
                  <label>Output Text</label>
                  <div className="code-wrapper">
                    <pre>{translationResult}</pre>
                  </div>
                </div>
              )}

              {translationReceipt && (
                <div className="form-group">
                  <label>Verification Proof Receipt</label>
                  <div className="code-wrapper" style={{ fontSize: '11px' }}>
                    <pre>{JSON.stringify(translationReceipt, null, 2)}</pre>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Compatibility Intel Registry */}
          <div>
            <div className="section-title">
              Compatibility Intel Registry
              <span className="section-subtitle">{registry.length} entries</span>
            </div>
            <div className="registry-list">
              {registry.length > 0 ? (
                registry.map((entry, idx) => (
                  <div key={idx} className="registry-item">
                    <div className="registry-meta">
                      <div className="registry-agents">
                        {entry.source_format.toUpperCase()} &rarr; {entry.target_format.toUpperCase()}
                      </div>
                      <div className="registry-service">
                        ID: {entry.service_id.substring(0, 16)}...
                      </div>
                    </div>
                    <div className="registry-arrow">&rarr;</div>
                  </div>
                ))
              ) : (
                <div className="empty-text">No cached compatibility matches in registry</div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
