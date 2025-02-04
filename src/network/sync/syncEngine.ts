import { Message } from '~/types';
import { MerkleTrie, NodeMetadata } from '~/network/sync/merkleTrie';
import { SyncId } from '~/network/sync/syncId';
import Engine from '~/storage/engine';
import { RPCClient } from '~/network/rpc/json';
import { err } from 'neverthrow';
import { logger } from '~/utils/logger';
import { TrieSnapshot } from '~/network/sync/trieNode';
import { HubError, HubResult } from '~/utils/hubErrors';

// Number of seconds to wait for the network to "settle" before syncing. We will only
// attempt to sync messages that are older than this time.
const SYNC_THRESHOLD_IN_SECONDS = 10;
const HASHES_PER_FETCH = 50;

const log = logger.child({
  component: 'SyncEngine',
});

/**
 * SyncEngine handles the logic required to determine where and how two hubs differ
 * from each other and bring them into sync efficiently. See https://github.com/farcasterxyz/hub/issues/66
 * for more details on design of the sync algorithm.
 */
class SyncEngine {
  private readonly _trie: MerkleTrie;
  private readonly engine: Engine;
  private _isSyncing = false;

  constructor(engine: Engine) {
    this._trie = new MerkleTrie();
    this.engine = engine;

    this.engine.on('messageMerged', async (_fid, _type, message) => {
      this.addMessage(message);
    });
    this.engine.onDBEvent('messageDeleted', async (message) => {
      // Note: There's no guarantee that the message is actually deleted, because the transaction could fail.
      // This is fine, because we'll just end up syncing the message again. It's much worse to miss a removal and cause
      // the trie to diverge in a way that's not recoverable without reconstructing it from the db.
      // Order of events does not matter. The trie will always converge to the same state.
      this.removeMessage(message);
    });
  }

  public async initialize() {
    // TODO: cache the trie to disk, and use this only when the cache doesn't exist
    let processedMessages = 0;
    await this.engine.forEachMessage((message) => {
      this.addMessage(message);
      processedMessages += 1;
      if (processedMessages % 10_000 === 0) {
        log.info({ processedMessages }, 'Initializing sync engine');
      }
    });
    log.info({ processedMessages }, 'Sync engine initialized');
  }

  public addMessage(message: Message): void {
    this._trie.insert(new SyncId(message));
  }

  public removeMessage(message: Message): void {
    this._trie.delete(new SyncId(message));
  }

  public shouldSync(excludedHashes: string[]): boolean {
    if (this._isSyncing) {
      log.debug('shouldSync: already syncing');
      return false;
    }

    const ourSnapshot = this.snapshot;
    const excludedHashesMatch =
      ourSnapshot.excludedHashes.length === excludedHashes.length &&
      ourSnapshot.excludedHashes.every((value, index) => value === excludedHashes[index]);

    log.debug(`shouldSync: excluded hashes check: ${excludedHashes}`);
    return !excludedHashesMatch;
  }

  async performSync(excludedHashes: string[], rpcClient: RPCClient) {
    try {
      this._isSyncing = true;
      const ourSnapshot = this.snapshot;

      const divergencePrefix = this._trie.getDivergencePrefix(ourSnapshot.prefix, excludedHashes);
      log.info({ divergencePrefix, prefix: ourSnapshot.prefix }, 'Divergence prefix');
      const missingIds = await this.fetchMissingHashesByPrefix(divergencePrefix, rpcClient);
      log.info({ missingCount: missingIds.length }, 'Fetched missing hashes');

      // TODO: sort missingIds by timestamp and fetch messages in batches
      await this.fetchAndMergeMessages(missingIds, rpcClient);
      log.info(`Sync complete`);
    } catch (e) {
      log.warn(e, `Error performing sync`);
    } finally {
      this._isSyncing = false;
    }
  }

  async fetchMissingHashesByPrefix(prefix: string, rpcClient: RPCClient): Promise<string[]> {
    const ourNode = this._trie.getTrieNodeMetadata(prefix);
    const theirNodeResult = await rpcClient.getSyncMetadataByPrefix(prefix);

    const missingHashes: string[] = [];
    await theirNodeResult.match(
      async (theirNode) => {
        missingHashes.push(...(await this.fetchMissingHashesByNode(theirNode, ourNode, rpcClient)));
      },
      async (err) => {
        log.warn(err, `Error fetching metadata for prefix ${prefix}`);
      }
    );
    return missingHashes;
  }

  async fetchMissingHashesByNode(
    theirNode: NodeMetadata,
    ourNode: NodeMetadata | undefined,
    rpcClient: RPCClient
  ): Promise<string[]> {
    const missingHashes: string[] = [];
    // If the node has fewer than HASHES_PER_FETCH, just fetch them all in go, otherwise,
    // iterate through the node's children and fetch them in batches.
    if (theirNode.numMessages <= HASHES_PER_FETCH) {
      const result = await rpcClient.getSyncIdsByPrefix(theirNode.prefix);
      result.match(
        (ids) => {
          missingHashes.push(...ids);
        },
        (err) => {
          log.warn(err, `Error fetching ids for prefix ${theirNode.prefix}`);
        }
      );
    } else if (theirNode.children) {
      for (const [theirChildChar, theirChild] of theirNode.children.entries()) {
        // recursively fetch hashes for every node where the hashes don't match
        if (ourNode?.children?.get(theirChildChar)?.hash !== theirChild.hash) {
          missingHashes.push(...(await this.fetchMissingHashesByPrefix(theirChild.prefix, rpcClient)));
        }
      }
    }
    return missingHashes;
  }

  public async fetchAndMergeMessages(hashes: string[], rpcClient: RPCClient): Promise<boolean> {
    let result = true;
    if (hashes.length === 0) {
      return false;
    }
    const messages = await rpcClient.getMessagesByHashes(hashes.map((hash) => '0x' + hash));
    await messages.match(
      async (msgs) => {
        const mergeResults = [];
        // Merge messages sequentially, so we can handle missing users.
        // TODO: Optimize by collecting all failures and retrying them in a batch
        for (const msg of msgs) {
          const result = await this.engine.mergeMessage(msg, 'SyncEngine');
          // Unknown user error
          if (result.isErr() && result.error.statusCode === 412) {
            log.warn({ fid: msg.data.fid }, 'Unknown user, fetching custody event');
            const result = await this.syncUserAndRetryMessage(msg, rpcClient);
            mergeResults.push(result);
          } else {
            mergeResults.push(result);
          }
        }
        log.info(
          { messages: mergeResults.length, success: mergeResults.filter((r) => r.isOk()).length },
          'Merged messages'
        );
      },
      async (err) => {
        // e.g. Node goes down while we're performing the sync. No need to handle it, the next round of sync will retry.
        log.warn(err, `Error fetching messages for sync`);
        result = false;
      }
    );
    return result;
  }

  public getTrieNodeMetadata(prefix: string): NodeMetadata | undefined {
    return this._trie.getTrieNodeMetadata(prefix);
  }

  public getIdsByPrefix(prefix: string): string[] {
    return this._trie.root.getNode(prefix)?.getAllValues() ?? [];
  }

  public get trie(): MerkleTrie {
    return this._trie;
  }

  public get snapshot(): TrieSnapshot {
    // Ignore the least significant digit when fetching the snapshot timestamp because
    // second resolution is too fine grained, and fall outside sync threshold anyway
    return this._trie.getSnapshot((this.snapshotTimestamp / 10).toString());
  }

  public get isSyncing(): boolean {
    return this._isSyncing;
  }

  // Returns the most recent timestamp in seconds that's within the sync threshold
  // (i.e. highest timestamp that's < current time and timestamp % sync_threshold == 0)
  public get snapshotTimestamp(): number {
    const currentTimeInSeconds = Math.floor(Date.now() / 1000);
    return Math.floor(currentTimeInSeconds / SYNC_THRESHOLD_IN_SECONDS) * SYNC_THRESHOLD_IN_SECONDS;
  }

  private async syncUserAndRetryMessage(message: Message, rpcClient: RPCClient): Promise<HubResult<void>> {
    const fid = message.data.fid;
    const custodyEventResult = await rpcClient.getCustodyEventByUser(fid);
    if (custodyEventResult.isErr()) {
      return err(new HubError('unavailable.network_failure', 'Failed to fetch custody event'));
    }
    await this.engine.mergeIdRegistryEvent(custodyEventResult.value, 'SyncEngine');
    // Probably not required to fetch the signer messages, but doing it here means
    //  sync will complete in one round (prevents messages failing to merge due to missed or out of order signer message)
    const signerMessagesResult = await rpcClient.getAllSignerMessagesByUser(fid);
    if (signerMessagesResult.isErr()) {
      return err(new HubError('unavailable.network_failure', 'Failed to fetch signer messages'));
    }
    const results = await Promise.all(this.engine.mergeMessages([...signerMessagesResult.value], 'SyncEngine'));
    if (results.every((r) => r.isErr())) {
      return err(new HubError('unavailable.storage_failure', 'Failed to merge signer messages'));
    } else {
      // if at least one signer message was merged, retry the original message
      return (await this.engine.mergeMessage(message, 'SyncEngine')).mapErr((e) => {
        return new HubError('unavailable.storage_failure', e);
      });
    }
  }
}

export { SyncEngine };
