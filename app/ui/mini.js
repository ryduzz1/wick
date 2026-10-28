// The mini window's page: the run state in words, and Stop.

const $ = (id) => document.getElementById(id);
const TARGETS = { sim: 'Simulator', testbench: 'Test bench', roblox: 'Roblox' };

const seconds = (ms) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

function render(s) {
  const where = TARGETS[s.target] ?? s.target;
  $('name').textContent = s.name;
  $('hotkey').textContent = `${s.hotkey} to stop`;
  $('label').classList.remove('error');
  let dot = 'dot';
  let label;
  if (s.phase === 'ended') {
    const end = s.end ?? {};
    $('stop').disabled = true;
    if (end.reason === 'done') {
      dot += ' on';
      label = `Done · ${seconds(s.elapsed)}`;
    } else if (end.reason === 'error') {
      dot += ' red';
      label = 'Error: the macro stopped';
      $('label').classList.add('error');
    } else {
      label = end.detail === 'kill switch' ? 'Stopped by the kill switch' : `Stopped · ${seconds(s.elapsed)}`;
    }
  } else {
    $('stop').disabled = false;
    if (!s.found) {
      dot += ' pulse';
      label = `Waiting for ${where}`;
    } else if (!s.focused) {
      dot += ' ember';
      label = `Paused: click ${where}`;
    } else {
      dot += ' ember pulse';
      const loops = s.loops ? ` · loop ${s.loops}` : '';
      label = `Running · ${seconds(s.elapsed)}${loops}${s.step ? ` · ${s.step}` : ''}`;
    }
  }
  $('dot').className = dot;
  $('label').textContent = label;
  $('label').title = label;
}

mini.onUpdate(render);
$('stop').onclick = () => mini.stop();
document.querySelector('.text').ondblclick = () => mini.showMain();
