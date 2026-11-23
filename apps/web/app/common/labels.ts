import type { Address } from "viem";

// Display names from docs.zknation.io (Schedule 3). Labels only: membership itself always comes
// from SecurityCouncil.members() on-chain, the ZK Foundation's Safe from the handler's zkFoundation().
const NAMES: Record<string, string> = {
  // Security Council
  "0x34ea62d4b9bbb8ad927efb6ab31e3ab3474ac93a": "OpenZeppelin",
  "0x35ea56fd9ead2567f339eb9564b6940b9dd5653f": "Cyfrin",
  "0x69462a81ba94d64c404575f1899a464f123497a2": "Nethermind",
  "0x84bf0ac41eeb74373ddddae8b7055bf2bd3ce6e0": "ChainLight",
  "0x9b8be3278b7f0168d82059eb6bac5991dcdfa803": "Spearbit",
  "0xb7ac3a79a23b148c85fba259712c5a1e7ad0ca44": "Dedaub",
  "0xc3abc9f9aa75be8341e831482cda0125a7b1a23e": "Matter Labs",
  "0xfb90da9dc45378a1b50775beb03ad10c7e8dc231": "PeckShield",
  "0x9b39ea22e838b316ea7d74e7c4b07d91d51cca88": "aleph_v",
  "0x725065b4eb99294baae57adda9c32e42f453fa8a": "Mariano Conti",
  "0x13f07d9bf17615f6a17f272fe1a913168c275a66": "Yev Broshevan",
  "0x3888777686f0b0d8c3108fc22ad8de9e049be26f": "Yoav Weiss",
  // ZKsync Foundation
  "0xbc1653bd3829dfec575afc3816d4899cd103b51c": "ZKsync Foundation",
};

export function memberLabel(address: Address): string | null {
  return NAMES[address.toLowerCase()] ?? null;
}
