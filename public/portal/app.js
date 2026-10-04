const $ = id => document.getElementById(id);
let registering = false, authenticated = false, groupsKey = '', polling = false;
const notice = text => { $('notice').textContent = text; };
async function api(route, data) {
  const r = await fetch('/api/' + route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await r.json();
  if (!r.ok) { if (r.status === 401 && authenticated) showAuth(); throw new Error(value.error); }
  return value;
}
function showAuth() { authenticated = false; $('auth').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; groupsKey = ''; $('mcpurl').value = ''; $('qr').removeAttribute('src'); }
$('toggle').onclick = () => { registering = !registering; $('registration').hidden = !registering; $('submit').textContent = registering ? 'Tạo tài khoản' : 'Đăng nhập'; $('toggle').textContent = registering ? 'Đã có tài khoản' : 'Tạo tài khoản mới'; document.querySelector('[name=password]').autocomplete = registering ? 'new-password' : 'current-password'; };
$('authform').onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.consent = e.target.elements.consent.checked; $('submit').disabled = true; try { await api(registering ? 'register' : 'login', b); e.target.reset(); notice(''); await refresh(); } catch (err) { notice(err.message); } finally { $('submit').disabled = false; } };
$('logout').onclick = async () => { try { await api('logout', {}); showAuth(); notice(''); } catch (err) { notice(err.message); } };
$('connect').onclick = async () => { try { await api('connect', {}); notice('Đang tạo mã QR. Vui lòng chờ một chút.'); await refresh(); } catch (err) { notice(err.message); } };
function renderGroups(s) {
  const key = JSON.stringify([s.groups, s.selected]); if (key === groupsKey) return; groupsKey = key;
  $('groups').replaceChildren();
  for (const g of s.groups) { const label = document.createElement('label'); label.className = 'group'; label.dataset.name = g.name.toLocaleLowerCase('vi'); const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'selected'; input.value = g.id; input.checked = s.selected.includes(g.id); const text = document.createElement('span'); text.textContent = g.name; const count = document.createElement('small'); count.textContent = g.members + ' thành viên'; text.append(count); label.append(input, text); $('groups').append(label); }
  filterGroups();
}
function filterGroups() { for (const row of $('groups').children) row.hidden = !row.dataset.name.includes($('search').value.toLocaleLowerCase('vi')); }
$('search').oninput = filterGroups;
$('groupform').onsubmit = async e => { e.preventDefault(); try { await api('groups', { selected: new FormData(e.target).getAll('selected') }); notice('Đang lưu nhóm đã chọn…'); setTimeout(refresh, 1000); } catch (err) { notice(err.message); } };
$('copy').onclick = async () => { try { await navigator.clipboard.writeText($('mcpurl').value); notice('Đã sao chép URL MCP.'); } catch { $('mcpurl').select(); notice('Chọn và sao chép URL trong ô phía trên.'); } };
async function refresh() {
  if (polling) return; polling = true;
  try { const s = await api('status'); authenticated = true; $('auth').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    $('qrbox').hidden = s.status !== 'qr'; $('connect').hidden = s.status === 'ready' || s.status === 'qr';
    $('connection').textContent = s.status === 'ready' ? 'Đã đăng nhập Zalo. Bạn có thể chọn nhóm bên dưới.' : s.status === 'error' ? 'Phiên kết nối bị gián đoạn. Bấm tạo mã QR để kết nối lại.' : 'Quét mã bằng ứng dụng Zalo trên điện thoại, rồi xác nhận đăng nhập.';
    if (s.status === 'qr') $('qr').src = '/api/qr?t=' + Date.now(); else $('qr').removeAttribute('src');
    $('groupsection').hidden = s.status !== 'ready'; renderGroups(s); $('mcpsection').hidden = !s.mcpUrl; $('mcpurl').value = s.mcpUrl || '';
  } catch (err) { if (authenticated) notice(err.message); } finally { polling = false; }
}
refresh(); setInterval(() => { if (authenticated) refresh(); }, 3000);
