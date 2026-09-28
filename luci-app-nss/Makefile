# SPDX-License-Identifier: GPL-2.0
# LuCI app for the NSS WiFi offload (custom NSS firmware, Qualcomm IPQ807x): settings + live status.

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI app for the NSS WiFi offload (settings and status)
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=Yury Ilyanok <yuryster@gmail.com>

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
