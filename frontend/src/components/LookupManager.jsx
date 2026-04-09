import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const TABS = [
  { key: 'herbicides', label: 'Herbicides' },
  { key: 'applicators', label: 'Applicators' },
  { key: 'weeds', label: 'Noxious Weeds' },
  { key: 'locations', label: 'Location Types' },
];

const inputStyle = {
  width: '100%',
  padding: '6px 10px',
  borderRadius: '6px',
  border: '1px solid #374151',
  backgroundColor: '#111827',
  color: '#f9fafb',
  fontSize: '0.85rem',
};

const btnStyle = (bg) => ({
  padding: '6px 14px',
  borderRadius: '6px',
  border: 'none',
  backgroundColor: bg,
  color: '#fff',
  fontSize: '0.8rem',
  cursor: 'pointer',
  fontWeight: 600,
});

export default function LookupManager() {
  const [tab, setTab] = useState('herbicides');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newExtra, setNewExtra] = useState('');
  const [newIsAccessRoad, setNewIsAccessRoad] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editExtra, setEditExtra] = useState('');
  const [editIsAccessRoad, setEditIsAccessRoad] = useState(false);

  useEffect(() => {
    loadItems();
  }, [tab]);

  async function loadItems() {
    setLoading(true);
    try {
      let data;
      if (tab === 'herbicides') data = await api.listHerbicides();
      else if (tab === 'applicators') data = await api.listApplicators();
      else if (tab === 'weeds') data = await api.listNoxiousWeeds();
      else if (tab === 'locations') data = await api.listLocationTypes();
      setItems(data || []);
    } catch (e) {
      console.error('Failed to load lookup items:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    try {
      if (tab === 'herbicides') await api.createHerbicide({ name: newName, pcp_number: newExtra || null });
      else if (tab === 'applicators') await api.createApplicator({ name: newName, license_number: newExtra || null });
      else if (tab === 'weeds') await api.createNoxiousWeed({ name: newName });
      else if (tab === 'locations') await api.createLocationType({ name: newName, is_access_road: newIsAccessRoad });
      setNewName('');
      setNewExtra('');
      setNewIsAccessRoad(false);
      await loadItems();
    } catch (e) {
      alert('Failed to add: ' + (e.message || e));
    }
  }

  async function handleUpdate(id) {
    try {
      if (tab === 'herbicides') await api.updateHerbicide(id, { name: editName, pcp_number: editExtra, is_active: true });
      else if (tab === 'applicators') await api.updateApplicator(id, { name: editName, license_number: editExtra, is_active: true });
      else if (tab === 'weeds') await api.updateNoxiousWeed(id, { name: editName, is_active: true });
      else if (tab === 'locations') await api.updateLocationType(id, { name: editName, is_access_road: editIsAccessRoad, is_active: true });
      setEditId(null);
      await loadItems();
    } catch (e) {
      alert('Failed to update: ' + (e.message || e));
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Remove this item?')) return;
    try {
      if (tab === 'herbicides') await api.deleteHerbicide(id);
      else if (tab === 'applicators') await api.deleteApplicator(id);
      else if (tab === 'weeds') await api.deleteNoxiousWeed(id);
      else if (tab === 'locations') await api.deleteLocationType(id);
      await loadItems();
    } catch (e) {
      alert('Failed to delete: ' + (e.message || e));
    }
  }

  function startEdit(item) {
    setEditId(item.id);
    setEditName(item.name);
    setEditExtra(item.pcp_number || item.license_number || '');
    setEditIsAccessRoad(item.is_access_road || false);
  }

  const showExtra = tab === 'herbicides' || tab === 'applicators';
  const extraLabel = tab === 'herbicides' ? 'PCP #' : 'License #';

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setEditId(null); }}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: tab === t.key ? '#3b82f6' : '#374151',
              color: '#f9fafb',
              fontSize: '0.8rem',
              cursor: 'pointer',
              fontWeight: tab === t.key ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Add new */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="Name"
          style={{ ...inputStyle, flex: 1, minWidth: '120px' }}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        {showExtra && (
          <input
            value={newExtra}
            onChange={e => setNewExtra(e.target.value)}
            placeholder={extraLabel}
            style={{ ...inputStyle, width: '100px' }}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
        )}
        {tab === 'locations' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={newIsAccessRoad} onChange={e => setNewIsAccessRoad(e.target.checked)} />
            Access Road
          </label>
        )}
        <button onClick={handleAdd} style={btnStyle('#22c55e')}>Add</button>
      </div>

      {/* Items list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px', color: '#9ca3af' }}>Loading...</div>
      ) : items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px', color: '#9ca3af' }}>No items yet. Add one above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {items.map(item => (
            <div key={item.id} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 10px',
              backgroundColor: '#111827',
              borderRadius: '6px',
              gap: '8px',
              flexWrap: 'wrap',
            }}>
              {editId === item.id ? (
                <>
                  <div style={{ display: 'flex', gap: '6px', flex: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input value={editName} onChange={e => setEditName(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: '100px' }} />
                    {showExtra && (
                      <input value={editExtra} onChange={e => setEditExtra(e.target.value)} placeholder={extraLabel} style={{ ...inputStyle, width: '90px' }} />
                    )}
                    {tab === 'locations' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}>
                        <input type="checkbox" checked={editIsAccessRoad} onChange={e => setEditIsAccessRoad(e.target.checked)} />
                        Road
                      </label>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button onClick={() => handleUpdate(item.id)} style={btnStyle('#3b82f6')}>Save</button>
                    <button onClick={() => setEditId(null)} style={btnStyle('#6b7280')}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{item.name}</span>
                    {item.pcp_number && <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}> ({item.pcp_number})</span>}
                    {item.license_number && <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}> ({item.license_number})</span>}
                    {item.is_access_road && <span style={{ color: '#f59e0b', fontSize: '0.75rem', marginLeft: '6px' }}>ROAD</span>}
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button onClick={() => startEdit(item)} style={btnStyle('#3b82f6')}>Edit</button>
                    <button onClick={() => handleDelete(item.id)} style={btnStyle('#ef4444')}>Delete</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
