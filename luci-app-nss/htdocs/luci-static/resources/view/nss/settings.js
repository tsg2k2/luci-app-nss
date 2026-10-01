'use strict';
'require view';
'require form';
'require fs';
'require uci';

/*
 * Settings of the NSS WiFi offload (/etc/config/nss, section 'offload', read by /etc/init.d/nss-offload).
 * The offload is armed once per boot, so every change here takes effect at the next reboot.
 */

/* "k1=v1 k2=a,b,c ..." helpers for the nss-peek argument strings */
function getArg(str, key) {
	var m = new RegExp('(?:^|\\s)' + key + '=(\\S*)').exec(str || '');
	return m ? m[1] : null;
}

function setArg(str, key, val) {
	var re = new RegExp('((?:^|\\s)' + key + '=)\\S*');
	return re.test(str || '') ? str.replace(re, '$1' + val) : ((str ? str + ' ' : '') + key + '=' + val);
}

function getListItem(str, key, i) {
	var v = getArg(str, key);
	return v == null ? null : (v.split(',')[i] || null);
}

function setListItem(str, key, i, val, nlanes) {
	var items = (getArg(str, key) || '').split(',').filter(function(x, k) { return k < nlanes; });
	while (items.length < nlanes) items.push('0');
	items[i] = val;
	return setArg(str, key, items.join(','));
}

/* lane index -> AP interface, from vif_rings ("phy0-ap0=0,phy1-ap0=1,phy2-ap0=2") */
function laneIfaces(vif) {
	var map = {};
	(vif || '').split(',').forEach(function(p) {
		var kv = p.split('=');
		if (kv.length == 2 && kv[0]) map[+kv[1]] = kv[0];
	});
	return map;
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('nss'),
			uci.load('firewall'),
			fs.list('/lib/firmware').catch(function() { return []; })
		]);
	},

	render: function(data) {
		var fw = (data[2] || []).map(function(e) { return e.name; })
			.filter(function(n) { return /^nss-wifi-.*\.bin$/.test(n); }).sort();
		var hwOff = uci.get_first('firewall', 'defaults', 'flow_offloading_hw') == '1';
		var lanes = uci.get('nss', 'offload', 'lanes') || '';
		var nlanes = parseInt(getArg(lanes, 'lanes') || '0', 10) || 0;
		var ifaces = laneIfaces(uci.get('nss', 'offload', 'vif_rings'));
		(getArg(lanes, 'lanevif') || '').split(',').forEach(function(n, i) {	/* the binding itself wins */
			if (n && n != '-') ifaces[i] = n;
		});
		var m, s, o;

		m = new form.Map('nss', _('NSS WiFi Offload – Settings'),
			_('The WiFi datapath of the offloaded radios runs on the NSS cores instead of the main CPU. ' +
			  'The offload is armed once per boot, after every radio\'s access point is up: changes on this page take effect after a <strong>reboot</strong>. ' +
			  'To go back to stock WiFi, untick "Enable" and reboot.'));

		if (!hwOff)
			m.description += '<div class="alert-message warning" style="margin-top:1em">' +
				_('Hardware flow offloading is off (Network → Firewall → General Settings → Routing/NAT offloading). ' +
				  'The NSS WiFi fast path rides the hardware flowtable, so the offload will not arm until it is set to "Hardware".') +
				'</div>';

		s = m.section(form.NamedSection, 'offload', 'offload');
		s.tab('general', _('General'));
		s.tab('buffers', _('Queues'));
		s.tab('advanced', _('Advanced'));

		o = s.taboption('general', form.Flag, 'enabled', _('Enable'),
			_('Arm the NSS WiFi offload at boot. Off = stock ath11k WiFi.'));
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'firmware', _('Firmware'),
			_('NSS firmware image in /lib/firmware. The 3-radio image (nss-wifi-3w-…) is the one the default lane layout expects.'));
		fw.forEach(function(n) { o.value(n); });
		if (!fw.length) o.value('nss-wifi-3w-pool-qcn-hr.bin');

		o = s.taboption('general', form.Flag, 'wifi_flows', _('WiFi flows in hardware'),
			_('Let the packet engine install flow entries for WiFi traffic, so the firmware forwards it without the host (the fast path).'));
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'lane_fallback', _('Automatic fallback on a stalled lane'),
			_('A watchdog always checks every firmware lane: one that stops making progress is logged and flagged on the Status page. ' +
			  'Ticked, the router also falls back on its own to the stock WiFi datapath until the next reboot. ' +
			  'Leave it off while testing, so a stall is noticed and can be reported. This setting applies immediately.'));
		o.rmempty = false;
		o.default = '0';

		o = s.taboption('general', form.Value, 'ap_wait', _('AP wait (s)'),
			_('How long to wait at boot for every radio\'s access point before giving up and staying on stock WiFi. 5 GHz DFS channels need ~60 s.'));
		o.datatype = 'range(30,1200)';
		o.placeholder = '240';

		/* Per-lane queue controls, edited inside the 'lanes' argument string */
		for (var i = 0; i < nlanes; i++) {
			(function(i) {
				var label = ifaces[i] ? '%s (lane %d)'.format(ifaces[i], i) : _('Lane %d').format(i);

				o = s.taboption('buffers', form.Value, '_cap' + i, _('%s: in-flight cap').format(label),
					_('Frames this lane may have queued in the radio (~5 ms of air is the target). Beyond it, frames wait in the lane where CoDel keeps latency low. 0 = the whole pool.'));
				o.datatype = 'range(0,4095)';
				o.cfgvalue = function(sid) { return getListItem(uci.get('nss', sid, 'lanes'), 'lanecap', i) || '0'; };
				o.write = function(sid, v) { uci.set('nss', sid, 'lanes', setListItem(uci.get('nss', sid, 'lanes'), 'lanecap', i, v, nlanes)); };
				o.remove = function() {};

				o = s.taboption('buffers', form.Value, '_buf' + i, _('%s: buffer pool').format(label),
					_('Frame buffers for this lane. At most 1023 on the SoC radios; up to 2047 on the PCIe 6 GHz radio.'));
				o.datatype = 'range(16,4095)';
				o.cfgvalue = function(sid) { return getListItem(uci.get('nss', sid, 'lanes'), 'lanebuf', i) || ''; };
				o.write = function(sid, v) { uci.set('nss', sid, 'lanes', setListItem(uci.get('nss', sid, 'lanes'), 'lanebuf', i, v, nlanes)); };
				o.remove = function() {};
			})(i);
		}
		if (!nlanes)
			s.taboption('buffers', form.DummyValue, '_nolanes', _('Lanes')).default = _('No lane layout configured (see Advanced).');

		o = s.taboption('advanced', form.Value, 'fwlanes', _('Firmware HW threads'),
			_('Must match the firmware image: tid0 plus one per worker lane (4 for the 3-radio image).'));
		o.datatype = 'range(2,9)';

		o = s.taboption('advanced', form.Value, 'lanes', _('Lane layout'),
			_('Arguments of the downlink lane staging (nss-peek): lanes, devices, TCL rings, PCIe pools, buffers, caps, vdevs.'));
		o.rmempty = false;

		o = s.taboption('advanced', form.Value, 'uplink', _('Uplink arm'),
			_('Arguments of the uplink arm (nss-peek).'));
		o.rmempty = false;

		o = s.taboption('advanced', form.Value, 'vif_rings', _('Downlink steer map'),
			_('AP interface → lane ring, for the packet engine\'s per-radio downlink steer.'));

		return m.render();
	}
});
