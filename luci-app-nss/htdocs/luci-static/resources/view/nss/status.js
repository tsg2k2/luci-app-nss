'use strict';
'require view';
'require fs';
'require poll';
'require uci';

/*
 * Live status of the NSS WiFi offload (custom NSS firmware on IPQ807x): read from the
 * nss-peek /proc/nss_ul dump, the ath11k / qca_ppe module parameters and the service log.
 */

var PROC = '/proc/nss_ul';
var P_ATH = '/sys/module/ath11k/parameters/';
var P_PPE = '/sys/module/qca_ppe/parameters/';

/* key=value pairs of a text fragment */
function kv(s) {
	var o = {}, re = /([A-Za-z_][A-Za-z0-9_]*)=([^\s\[]+)/g, m;
	while ((m = re.exec(s || '')) !== null)
		o[m[1]] = m[2];
	return o;
}

/* one row of /proc/nss_ul by its leading tag */
function row(text, tag) {
	var re = new RegExp('^' + tag + '\\b(.*)$', 'm'), m = re.exec(text || '');
	return m ? m[1] : null;
}

/* a per-worker row ("... li0 k=v ... li1 k=v ...") -> [ {k: v}, ... ] indexed by lane */
function perLane(line) {
	var out = [], re = /\bli(\d+) ([\s\S]*?)(?=\bli\d+ |$)/g, m;
	while ((m = re.exec(line || '')) !== null)
		out[+m[1]] = kv(m[2]);
	return out;
}

function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

function fmtRate(fps) {
	if (fps == null) return '–';
	if (fps >= 1e6) return (fps / 1e6).toFixed(2) + ' Mpps';
	if (fps >= 1e3) return (fps / 1e3).toFixed(1) + ' kpps';
	return fps.toFixed(0) + ' pps';
}

function badge(ok, yes, no) {
	return E('span', { 'class': 'label ' + (ok ? 'success' : 'warning'),
		'style': 'padding:2px 6px;border-radius:3px;color:#fff;background:' + (ok ? '#2e7d32' : '#b26a00') },
		ok ? yes : no);
}

function readFile(p) {
	return fs.read(p).then(function(v) { return (v || '').trim(); }).catch(function() { return null; });
}

/* lane index -> AP interface name, from nss.offload.vif_rings ("phy0-ap0=0,phy1-ap0=1,...") */
function laneNames() {
	var map = {}, v = uci.get('nss', 'offload', 'vif_rings') || '';
	v.split(',').forEach(function(p) {
		var kvp = p.split('=');
		if (kvp.length == 2 && kvp[0]) map[+kvp[1]] = kvp[0];
	});
	return map;
}

var prev = null;	/* { t, dl: [reaped...], ul: [reaped...], hb } for rates and liveness */

function snapshot() {
	return Promise.all([
		readFile(PROC),
		readFile(P_ATH + 'ath11k_nss_offload'),
		readFile(P_PPE + 'wifi_dl'),
		readFile(P_PPE + 'wifi_flows'),
		fs.exec_direct('/sbin/logread', [ '-e', 'nss-offload' ]).catch(function() { return ''; })
	]).then(function(r) {
		return { proc: r[0], offload: r[1], wifi_dl: r[2], wifi_flows: r[3], log: r[4] || '', t: Date.now() };
	});
}

function renderOverview(s) {
	var p = s.proc || '', abi = row(p, 'abi') || '', fwb = kv(row(p, 'fwbuild') || ''),
	    exc = kv(row(p, 'exc') || ''), act = row(p, 'dl_active') || '',
	    raw = parseInt(fwb.raw || '0', 16) || 0, hb = num(exc.heartbeat),
	    live = prev && prev.hb != null ? hb > prev.hb : null,
	    stamps = kv(abi), feats = [];

	if (raw & 0x40) feats.push('CoDel');
	if (raw & 0x02) feats.push(_('per-lane TID'));
	if (raw & 0x04) feats.push('DIAG');

	var rows = [
		[ _('Offload'), s.offload == null ? _('not available (non-NSS build)') :
			badge(s.offload == 'Y', _('armed'), _('off (stock WiFi)')) ],
		[ _('Firmware alive'), !s.proc ? '–' : live == null ? _('checking…') :
			badge(live, _('yes (heartbeat %d)').format(hb), _('NO – heartbeat stalled')) ],
		[ _('Host/firmware ABI'), !abi ? '–' : badge(/MATCH/.test(abi),
			_('match (%s)').format(stamps.fw_stamp || '?'),
			_('MISMATCH fw %s host %s').format(stamps.fw_stamp || '?', stamps.host_stamp || '?')) ],
		[ _('Firmware build'), fwb.lanes ? _('%d HW threads (%d worker lanes)%s').format(num(fwb.lanes), num(fwb.lanes) - 1,
			feats.length ? ', ' + feats.join(', ') : '') : '–' ],
		[ _('WiFi RX ring ownership'), !act ? '–' : badge(/go=2/.test(act), _('firmware (granted)'), _('host')) ],
		[ _('Downlink steer'), s.wifi_dl == null ? '–' : badge(s.wifi_dl == 'Y' || s.wifi_dl == '1', _('on'), _('off')) ],
		[ _('WiFi flows in PPE'), s.wifi_flows == null ? '–' : ((s.wifi_flows == 'Y' || s.wifi_flows == '1') ? _('on') : _('off')) ],
		[ _('Exceptions to host'), exc.head != null ? _('%d (to the host stack: handshakes, unknown flows)').format(num(exc.head)) : '–' ]
	];

	return E('table', { 'class': 'table' }, rows.map(function(r) {
		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td left', 'width': '33%' }, r[0]),
			E('td', { 'class': 'td left' }, r[1])
		]);
	}));
}

function renderLanes(s) {
	var p = s.proc || '', dl = perLane(row(p, 'dlreap')), ul = perLane(row(p, 'ulreap')),
	    names = laneNames(), dt = prev ? (s.t - prev.t) / 1000 : 0, rows = [];

	var hdr = [ _('Lane'), _('AP'), _('DL frames'), _('DL rate'), _('In flight'), _('CoDel drops'),
	            _('TCL full'), _('TX errors'), _('UL frames'), _('UL rate'), _('UL to host') ];

	for (var i = 0; i < Math.max(dl.length, ul.length); i++) {
		var d = dl[i] || {}, u = ul[i] || {};
		if (!d.pass && !u.nreo) continue;
		if (num(d.pass) == 0 && num(u.reaped) == 0 && num(d.reaped) == 0 && names[i] == null) continue;	/* unstaged lane */
		var dr = prev && dt > 0 ? (num(d.completed) - (prev.dl[i] || 0)) / dt : null,
		    ur = prev && dt > 0 ? (num(u.reaped) - (prev.ul[i] || 0)) / dt : null;
		rows.push([ String(i), names[i] || '–', String(num(d.completed)), fmtRate(dr),
		            String(num(d.inflight)), String(num(d.codel)), String(num(d.tclfull)),
		            String(num(d.wbmerr)), String(num(u.reaped)), fmtRate(ur), String(num(u.exc)) ]);
	}

	return E('table', { 'class': 'table' }, [
		E('tr', { 'class': 'tr table-titles' }, hdr.map(function(h) { return E('th', { 'class': 'th' }, h); }))
	].concat(rows.length ? rows.map(function(r) {
		return E('tr', { 'class': 'tr' }, r.map(function(c) { return E('td', { 'class': 'td' }, c); }));
	}) : [ E('tr', { 'class': 'tr placeholder' }, [ E('td', { 'class': 'td' }, E('em', {}, _('No lanes armed'))) ]) ]));
}

function renderLog(s) {
	var lines = (s.log || '').trim().split('\n').filter(function(l) { return /nss-offload/.test(l) && /user\./.test(l); }).slice(-8);
	return E('pre', { 'style': 'white-space:pre-wrap;font-size:90%' },
		lines.length ? lines.join('\n') : _('No messages from the nss-offload service since boot.'));
}

function remember(s) {
	var p = s.proc || '', dl = perLane(row(p, 'dlreap')), ul = perLane(row(p, 'ulreap'));
	prev = { t: s.t, hb: num(kv(row(p, 'exc') || '').heartbeat),
	         dl: dl.map(function(d) { return num((d || {}).completed); }),
	         ul: ul.map(function(u) { return num((u || {}).reaped); }) };
}

return view.extend({
	load: function() {
		return Promise.all([ uci.load('nss'), snapshot() ]).then(function(r) { return r[1]; });
	},

	update: function(s) {
		var o = document.getElementById('nss-overview'), l = document.getElementById('nss-lanes'),
		    g = document.getElementById('nss-log');
		if (o) o.replaceChildren(renderOverview(s));
		if (l) l.replaceChildren(renderLanes(s));
		if (g) g.replaceChildren(renderLog(s));
		remember(s);
	},

	render: function(s) {
		var node = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('NSS WiFi Offload – Status')),
			E('div', { 'class': 'cbi-map-descr' },
				_('The WiFi datapath of the offloaded radios runs on the NSS cores, not the main CPU. Counters are cumulative since the offload was armed; rates are measured between refreshes.')),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Overview')), E('div', { 'id': 'nss-overview' }) ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Lanes')), E('div', { 'id': 'nss-lanes' }) ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Service log')), E('div', { 'id': 'nss-log' }) ])
		]);

		var self = this;
		requestAnimationFrame(function() { self.update(s); });
		poll.add(function() { return snapshot().then(function(n) { self.update(n); }); }, 2);
		return node;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
