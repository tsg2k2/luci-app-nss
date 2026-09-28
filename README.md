# luci-app-nss

LuCI app for the **NSS WiFi offload** on Qualcomm IPQ807x boards running the custom
NSS firmware (the Verizon CR1000A build: 2.4 / 5 GHz SoC radios + the QCN9074 6 GHz
PCIe radio). The WiFi datapath runs on the NSS cores instead of the main CPU; this app
shows what it is doing and edits how it is armed.

Adds **Network → NSS WiFi Offload** with two pages:

* **Status** (auto-refresh, 2 s): offload armed or not, firmware liveness (heartbeat),
  host/firmware ABI match, firmware build features (e.g. CoDel), WiFi RX-ring ownership,
  downlink steer, and a per-lane table – downlink / uplink frames and live rates, frames
  in flight and the live in-flight cap, CoDel drops, TCL-full stops, TX errors, exceptions to the host – plus the
  `nss-offload` service's log. Read from `/proc/nss_ul` (nss-peek), the ath11k / qca_ppe
  module parameters and `logread`.
* **Settings** (`/etc/config/nss`, section `offload`): enable, firmware image, WiFi
  flows in hardware, AP wait, per-lane in-flight caps and buffer pools, and the raw
  lane / uplink / steer arguments. The offload is armed once per boot by
  `/etc/init.d/nss-offload`, so changes apply after a reboot. The firewall's
  *Routing/NAT offloading* choice must be "Hardware" for it to arm; the page warns
  when it is not.

## Build

Add as a feed and install:

```
echo "src-git luci_nss https://github.com/tsg2k2/luci-app-nss.git" >> feeds.conf.default
./scripts/feeds update luci_nss
./scripts/feeds install luci-app-nss
make menuconfig   # enable LuCI -> 3. Applications -> luci-app-nss
```

Requires the NSS offload stack of the CR1000A tree (`kmod-nss-loader`, the ath11k NSS
patches, `/etc/init.d/nss-offload`).
