// The only entry point of the WalletConnect browser bundle.
//
// It exposes the low-level EthereumProvider and QRCode generator. The Reown AppKit modal is not imported: it
// writes inline <style>, which the page CSP forbids. The SDK draws its own QR modal.
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import QRCode from "qrcode";

export { EthereumProvider, QRCode };
