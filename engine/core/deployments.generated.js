// GENERATED FILE - do not edit. Run: node tools/gen-deployment-pins.mjs --write
// Source: deployments/<vm>/<network>.json, copied from the reviewed contract release manifest.
// Factory history: deployments/history/<vm>/<network>.json, mainnet-only retired factories for recovery.
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

const DATA = {
  "arbitrum-sepolia": {
    "vm": "evm",
    "network": "arbitrum-sepolia",
    "caip2": "eip155:421614",
    "chainRef": "421614",
    "status": "live",
    "release": {
      "tag": "contracts-testnet-2026.11.04",
      "commit": "930366a387c0c696bda6f5c038f23617447ebb78",
      "toolchain": "0.8.38",
      "deployedAt": "2026-11-04T15:00:55.822Z"
    },
    "anchor": {
      "kind": "block",
      "value": "326005419"
    },
    "artifacts": {
      "factory": {
        "role": "factory",
        "kind": "contract",
        "address": "0x245d3a4ac4b98d713f6c5130b56cd5d550f8cefe",
        "addressFormat": "hex-20",
        "codeHash": "0x1fdfa1c922f660506243cab4c889aa83e22ce27d818bac9c5e4ecbccbdd04906",
        "hashKind": "keccak256",
        "tx": {
          "kind": "hash",
          "value": "0xf62f54cbb0c236edc467652fce8c746c903a5d0ab4ecdd492649d57a92862296"
        }
      },
      "cashier": {
        "role": "cashier",
        "kind": "contract",
        "address": "0x40515449159EfbCb5eF5eB9e2E08ba432E150a1C",
        "addressFormat": "hex-20",
        "tx": {
          "kind": "hash",
          "value": "0xf62f54cbb0c236edc467652fce8c746c903a5d0ab4ecdd492649d57a92862296"
        }
      },
      "registry": {
        "role": "registry",
        "kind": "contract",
        "address": "0x92191dc3517e15db6468628b1a493576728a9798",
        "addressFormat": "hex-20",
        "tx": {
          "kind": "hash",
          "value": "0x8f60792dac889008ec5678c6f30790730d278518d512a3b19657829896391adf"
        }
      },
      "implementation": {
        "role": "implementation",
        "kind": "contract",
        "address": "0xF88658b53FcB965E580638bbFe048E8f587d6D11",
        "addressFormat": "hex-20",
        "codeHash": "0x7020a1017adbb4d4ce4710f7c632d48a5469a6f3076608e77d5675dee125653c",
        "hashKind": "keccak256",
        "tx": {
          "kind": "hash",
          "value": "0xf62f54cbb0c236edc467652fce8c746c903a5d0ab4ecdd492649d57a92862296"
        }
      }
    },
    "escrow": {
      "address": "0x245d3a4ac4b98d713f6c5130b56cd5d550f8cefe",
      "mode": "live",
      "deploymentBlock": 326005419,
      "cashier": "0x40515449159EfbCb5eF5eB9e2E08ba432E150a1C",
      "registry": "0x92191dc3517e15db6468628b1a493576728a9798",
      "implementationCodeHash": "0x7020a1017adbb4d4ce4710f7c632d48a5469a6f3076608e77d5675dee125653c"
    },
    "knownFactoryCodes": [
      "0x1fdfa1c922f660506243cab4c889aa83e22ce27d818bac9c5e4ecbccbdd04906"
    ]
  }
};
const HISTORY_DATA = {
  "arbitrum-sepolia": [
    {
      "address": "0x245d3a4ac4b98d713f6c5130b56cd5d550f8cefe",
      "deploymentBlock": 326005419,
      "release": {
        "tag": "contracts-testnet-2026.11.04",
        "commit": "930366a387c0c696bda6f5c038f23617447ebb78",
        "toolchain": "0.8.38",
        "deployedAt": "2026-11-04T15:00:55.822Z"
      },
      "status": "live"
    }
  ]
};

export const DEPLOYMENTS = freeze(DATA);
export const DEPLOYMENT_CHAINS = freeze(Object.keys(DATA).sort());
export const DEPLOYMENT_VMS = freeze([...new Set(Object.values(DATA).map((d) => d.vm))].sort());
export const FACTORY_HISTORY = freeze(HISTORY_DATA);

// Accept a network id, a CAIP-2, or an EVM chain id. No fallback to another network: an unknown deployment is null.
export function deploymentFor(chainOrId) {
  if (chainOrId === null || chainOrId === undefined) return null;
  const value = typeof chainOrId === "object"
    ? chainOrId.id ?? chainOrId.network ?? chainOrId.caip2
    : chainOrId;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || /^[0-9]+$/.test(String(value))) {
    return Object.values(DEPLOYMENTS).find((d) => Number(d.chainRef) === Number(value)) ?? null;
  }
  return DEPLOYMENTS[value] ?? Object.values(DEPLOYMENTS).find((d) => d.caip2 === value) ?? null;
}
