import { AddressInfo } from 'net';
import { err, ok } from 'neverthrow';
import { GossipVersion } from '~/flatbuffers/generated/gossip_generated';
import { IdRegistryEvent, Message } from '~/types';
import { isGossipMessage } from '~/types/typeguards';
import { HubError, HubResult } from '~/utils/hubErrors';
import { safeJsonParse, safeJsonStringify } from '~/utils/safe';

// Network topic for all FC protocol messages
export const NETWORK_TOPIC_PRIMARY = 'f_network_topic_primary';
// Network topic for node contact info messages
export const NETWORK_TOPIC_CONTACT = 'f_network_topic_contact';
// The rate at which nodes republish their contact info
export const GOSSIP_CONTACT_INTERVAL = 10_000;
// A list of all gossip topics in use by our protocol
export const GOSSIP_TOPICS = [NETWORK_TOPIC_CONTACT, NETWORK_TOPIC_PRIMARY];
// The current gossip protocol version
export const GOSSIP_PROTOCOL_VERSION = GossipVersion.V1;

/**
 * GossipMessage defines the structure of the basic message type that is published
 * over the gossip network
 *
 * @content - The message content to be broadcasted
 * @topics - The topics this message belongs to. Multiple topics can be passed.
 */
export type GossipMessage<T = Content> = {
  content: T;
  topics: string[];
};

export type Content = IdRegistryContent | UserContent | ContactInfoContent;

/**
 * UserContent defines the structure of the primary message type that is published
 * over the gossip network.
 *
 * @message - The Farcaster Message that needs to be sent
 */
export type UserContent = {
  message: Message;
};

/**
 * IdRegistryContent defines the structure of the IdRegistry Events that are published
 * over the gossip network.
 *
 * @message - The Farcaster IdRegistryEvent that needs to be sent
 */
export type IdRegistryContent = {
  message: IdRegistryEvent;
};

/**
 * ContactInfoContent allows gossip nodes to share additional information about each other
 * over the gossip network.
 *
 * @publicKey - The publicKey of the corresponding peer
 * @gossipAddress - The address at which this node is listening for Gossip messages. Unset if Gossip is not public.
 * @rpcAddress - The address at which this node is serving RPC requests. Unset if RPC is not offered.
 * @excludedHashes - The excluded hashes of the sender's current trie snapshot
 * @count - The number of messages under the root
 */
export type ContactInfoContent = {
  peerId: string;
  gossipAddress?: AddressInfo;
  rpcAddress?: AddressInfo;
  excludedHashes: string[];
  count: number;
};

/**
 * Encodes a GossipMessage to a UTF-8 encoded array that can be broadcast over the gossip network
 *
 * @message - the GossipMessage to encode for the network
 *
 * @return - A byte array containing the UTF-8 encoded message
 */
export const encodeMessage = (message: GossipMessage): HubResult<Uint8Array> => {
  if (!isGossipMessage(message)) {
    return err(new HubError('bad_request.parse_failure', 'invalid gossip message'));
  }

  const jsonResult = safeJsonStringify(message);
  if (jsonResult.isErr()) return err(jsonResult.error);

  return ok(new TextEncoder().encode(jsonResult.value));
};

/**
 * Decodes a GossipMessage from a UTF-8 encoded arrray
 *
 * @data - The message data
 *
 * @returns - A decoded GossipMessage from the input array
 */
export const decodeMessage = (data: Uint8Array): HubResult<GossipMessage> => {
  const json = new TextDecoder().decode(data);

  return safeJsonParse(json).andThen((message) => {
    if (!message || !isGossipMessage(message)) {
      return err(new HubError('bad_request.parse_failure', 'invalid gossip message'));
    }
    return ok(message);
  });
};
