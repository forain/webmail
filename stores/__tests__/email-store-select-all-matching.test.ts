import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useSettingsStore } from '../settings-store';
import { UNIFIED_INBOX } from '@/lib/jmap/types';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';

// "Select all matching": a batch action over every email of the current view,
// not only the loaded page. The selection is pinned to the view it was made in
// and voided by any change of view or any hand-made selection change; at
// action time the ids are enumerated server-side with the same filter the
// list is fetched with, and the action must never silently cover a subset.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    role: 'inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
      maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
    },
    isSubscribed: true,
    isShared: false,
    ...overrides,
  };
}

function makeEmail(id: string, overrides: Partial<Email> = {}): Email {
  return {
    id,
    threadId: `t-${id}`,
    subject: `mail ${id}`,
    receivedAt: '2026-09-01T10:00:00Z',
    keywords: {},
    mailboxIds: { inbox: true },
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    preview: '',
    hasAttachment: false,
    size: 1,
    ...overrides,
  } as Email;
}

type MockClient = IJMAPClient & {
  queryAllEmailIds: ReturnType<typeof vi.fn>;
  batchMoveEmails: ReturnType<typeof vi.fn>;
  batchDeleteEmails: ReturnType<typeof vi.fn>;
  batchMarkAsRead: ReturnType<typeof vi.fn>;
  getEmails: ReturnType<typeof vi.fn>;
  searchEmails: ReturnType<typeof vi.fn>;
};

function makeClient(accountId = 'primary', matchingIds: string[] = []): MockClient {
  return {
    getAccountId: () => accountId,
    queryAllEmailIds: vi.fn(async () => ({ ids: matchingIds, total: matchingIds.length, complete: true })),
    batchMoveEmails: vi.fn(async () => undefined),
    batchDeleteEmails: vi.fn(async () => undefined),
    batchMarkAsRead: vi.fn(async () => undefined),
    getEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0 })),
    searchEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0 })),
    getMailboxes: vi.fn(async () => [makeMailbox()]),
    getAllMailboxes: vi.fn(async () => [makeMailbox()]),
  } as unknown as MockClient;
}

const loaded = ['m1', 'm2', 'm3'];
const everyMatching = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];

describe('select all matching', () => {
  let client: MockClient;

  beforeEach(() => {
    client = makeClient('primary', everyMatching);
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: () => undefined as never,
      getAllConnectedClients: () => new Map(),
    } as never);
    useSettingsStore.setState({ emailsPerPage: 3, deleteAction: 'trash', includeGroupInUnified: false });
    useEmailStore.setState({
      emails: loaded.map((id) => makeEmail(id)),
      totalEmails: everyMatching.length,
      hasMoreEmails: true,
      selectedEmailIds: new Set(),
      allMatchingScope: null,
      lastSelectedEmailId: null,
      selectedEmail: null,
      selectedMailbox: 'inbox',
      selectedKeyword: null,
      viewingAccountId: null,
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      searchQuery: '',
      searchMailboxId: '',
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      mailboxes: [makeMailbox(), makeMailbox({ id: 'trash', name: 'Trash', role: 'trash' })],
      accountMailboxes: {},
      error: null,
      isLoading: false,
      isLoadingMore: false,
    });
  });

  describe('selection state', () => {
    it('selects the loaded page and pins the selection to the current view', () => {
      useEmailStore.getState().selectAllMatching();
      const state = useEmailStore.getState();
      expect(Array.from(state.selectedEmailIds)).toEqual(loaded);
      expect(state.isAllMatchingSelected()).toBe(true);
    });

    it('is voided by a hand-made change to the selection', () => {
      useEmailStore.getState().selectAllMatching();
      useEmailStore.getState().toggleEmailSelection('m2');
      expect(useEmailStore.getState().isAllMatchingSelected()).toBe(false);
      expect(useEmailStore.getState().selectedEmailIds.has('m2')).toBe(false);
    });

    it('is voided by page-level select all and by clearing', () => {
      useEmailStore.getState().selectAllMatching();
      useEmailStore.getState().selectAllEmails();
      expect(useEmailStore.getState().isAllMatchingSelected()).toBe(false);

      useEmailStore.getState().selectAllMatching();
      useEmailStore.getState().clearSelection();
      expect(useEmailStore.getState().isAllMatchingSelected()).toBe(false);
      expect(useEmailStore.getState().allMatchingScope).toBeNull();
    });

    it('does not survive a change of folder, search or tab', () => {
      useEmailStore.getState().selectAllMatching();
      useEmailStore.setState({ searchQuery: 'invoice' });
      expect(useEmailStore.getState().isAllMatchingSelected()).toBe(false);
      useEmailStore.setState({ searchQuery: '' });
      expect(useEmailStore.getState().isAllMatchingSelected()).toBe(true);

      useEmailStore.getState().selectMailbox('trash');
      expect(useEmailStore.getState().isAllMatchingSelected()).toBe(false);
      expect(useEmailStore.getState().allMatchingScope).toBeNull();
    });

    it('is refused in the scheduled view', () => {
      useEmailStore.setState({ selectedMailbox: '__scheduled__' });
      useEmailStore.getState().selectAllMatching();
      expect(useEmailStore.getState().allMatchingScope).toBeNull();
    });

    it('keeps a newly loaded page selected', async () => {
      useEmailStore.getState().selectAllMatching();
      client.getEmails.mockResolvedValueOnce({ emails: [makeEmail('m4'), makeEmail('m5')], hasMore: true, total: 7 });

      await useEmailStore.getState().loadMoreEmails(client);

      const state = useEmailStore.getState();
      expect(state.emails.map((e) => e.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      expect(Array.from(state.selectedEmailIds)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      expect(state.isAllMatchingSelected()).toBe(true);
    });
  });

  describe('resolveSelectedEmailIds', () => {
    it('returns the explicit selection without asking the server', async () => {
      useEmailStore.getState().toggleEmailSelection('m1');
      useEmailStore.getState().toggleEmailSelection('m3');

      const ids = await useEmailStore.getState().resolveSelectedEmailIds(client);

      expect(ids).toEqual(['m1', 'm3']);
      expect(client.queryAllEmailIds).not.toHaveBeenCalled();
    });

    it('enumerates the folder with the same filter the list uses', async () => {
      useEmailStore.getState().selectAllMatching();

      const ids = await useEmailStore.getState().resolveSelectedEmailIds(client);

      expect(ids).toEqual(everyMatching);
      expect(client.queryAllEmailIds).toHaveBeenCalledWith({ inMailbox: 'inbox' }, undefined);
    });

    it('enumerates a text search under the search scope, not the open folder', async () => {
      useEmailStore.setState({
        searchQuery: 'invoice',
        searchMailboxId: '',
        mailboxes: [
          makeMailbox(),
          makeMailbox({ id: 'owner:shared', originalId: 'shared', name: 'Shared', isShared: true, accountId: 'owner' }),
        ],
      });
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().resolveSelectedEmailIds(client);
      expect(client.queryAllEmailIds).toHaveBeenLastCalledWith({ text: 'invoice*' }, undefined);

      // Scoped to a shared folder: the folder's bare id and its owner account.
      useEmailStore.setState({ searchMailboxId: 'owner:shared' });
      useEmailStore.getState().selectAllMatching();
      await useEmailStore.getState().resolveSelectedEmailIds(client);
      expect(client.queryAllEmailIds).toHaveBeenLastCalledWith(
        { operator: 'AND', conditions: [{ inMailbox: 'shared' }, { text: 'invoice*' }] },
        'owner',
      );
    });

    it('enumerates an advanced search with its filters', async () => {
      useEmailStore.setState({
        searchQuery: '',
        searchFilters: { ...DEFAULT_SEARCH_FILTERS, from: 'boss@example.com', isUnread: true },
      });
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().resolveSelectedEmailIds(client);

      expect(client.queryAllEmailIds).toHaveBeenCalledWith(
        { operator: 'AND', conditions: [{ from: 'boss@example.com' }, { notKeyword: '$seen' }] },
        undefined,
      );
    });

    it('enumerates a tag view across folders', async () => {
      useEmailStore.setState({ selectedKeyword: 'work' });
      useEmailStore.getState().selectAllMatching();

      const ids = await useEmailStore.getState().resolveSelectedEmailIds(client);

      expect(ids).toEqual(everyMatching);
      expect(client.queryAllEmailIds).toHaveBeenCalledWith({ hasKeyword: '$label:work' }, undefined);
    });

    it('keeps a listed selection that the server walk does not return', async () => {
      // A plugin can inject search hits that no server filter reproduces.
      useEmailStore.setState({ emails: [...loaded, 'plugin-hit'].map((id) => makeEmail(id)) });
      useEmailStore.getState().selectAllMatching();

      const ids = await useEmailStore.getState().resolveSelectedEmailIds(client);

      expect(ids).toEqual([...loaded, 'plugin-hit', 'm4', 'm5', 'm6', 'm7']);
    });

    it('refuses to act on a partial enumeration', async () => {
      client.queryAllEmailIds.mockResolvedValueOnce({ ids: ['m1'], total: 7, complete: false });
      useEmailStore.getState().selectAllMatching();

      await expect(useEmailStore.getState().resolveSelectedEmailIds(client)).rejects.toThrow(/every matching email/);
    });
  });

  describe('batch actions', () => {
    it('batchDelete trashes every matching email, then re-reads the list', async () => {
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().batchDelete(client);

      expect(client.batchMoveEmails).toHaveBeenCalledTimes(1);
      expect(client.batchMoveEmails).toHaveBeenCalledWith(everyMatching, 'trash', undefined, false);
      const state = useEmailStore.getState();
      expect(state.selectedEmailIds.size).toBe(0);
      expect(state.allMatchingScope).toBeNull();
      expect(state.error).toBeNull();
      // The rest of the folder is not known locally: the list is re-fetched.
      expect(client.getEmails).toHaveBeenCalled();
    });

    it('batchDelete destroys permanently inside Trash', async () => {
      useEmailStore.setState({ selectedMailbox: 'trash', emails: loaded.map((id) => makeEmail(id, { mailboxIds: { trash: true } })) });
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().batchDelete(client);

      expect(client.queryAllEmailIds).toHaveBeenCalledWith({ inMailbox: 'trash' }, undefined);
      expect(client.batchDeleteEmails).toHaveBeenCalledWith(everyMatching, undefined);
      expect(client.batchMoveEmails).not.toHaveBeenCalled();
    });

    it('batchMarkAsRead covers every matching email', async () => {
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().batchMarkAsRead(client, true);

      expect(client.batchMarkAsRead).toHaveBeenCalledWith(everyMatching, true, undefined);
      expect(useEmailStore.getState().allMatchingScope).toBeNull();
    });

    it('batchMoveToMailbox covers every matching email', async () => {
      useEmailStore.setState({ mailboxes: [...useEmailStore.getState().mailboxes, makeMailbox({ id: 'archive', name: 'Archive', role: 'archive' })] });
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().batchMoveToMailbox(client, 'archive');

      expect(client.batchMoveEmails).toHaveBeenCalledWith(everyMatching, 'archive', undefined);
    });

    it('does nothing server-side when the enumeration fails', async () => {
      client.queryAllEmailIds.mockRejectedValueOnce(new Error('server down'));
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().batchDelete(client);

      expect(client.batchMoveEmails).not.toHaveBeenCalled();
      expect(client.batchDeleteEmails).not.toHaveBeenCalled();
      const state = useEmailStore.getState();
      expect(state.error).toBe('server down');
      expect(state.isLoading).toBe(false);
      // The list is untouched; the user can retry.
      expect(state.emails.map((e) => e.id)).toEqual(loaded);
    });

    it('stays page-scoped for an explicit selection', async () => {
      useEmailStore.getState().selectAllEmails();

      await useEmailStore.getState().batchDelete(client);

      expect(client.queryAllEmailIds).not.toHaveBeenCalled();
      expect(client.batchMoveEmails).toHaveBeenCalledWith(loaded, 'trash', undefined, false);
    });
  });

  describe('unified view', () => {
    it('enumerates per account and routes each batch to its own client', async () => {
      const clientA = makeClient('jmap-a', ['a1', 'a2', 'a3']);
      const clientB = makeClient('jmap-b', ['b1', 'b2']);
      clientA.getMailboxes = vi.fn(async () => [makeMailbox({ id: 'a-inbox' })]);
      clientB.getMailboxes = vi.fn(async () => [makeMailbox({ id: 'b-inbox' })]);
      useAccountStore.setState({
        accounts: [
          { id: 'account-a', email: 'a@example.com', label: 'A', isConnected: true },
          { id: 'account-b', email: 'b@example.com', label: 'B', isConnected: true },
        ],
      } as never);
      useAuthStore.setState({
        activeAccountId: 'account-a',
        getClientForAccount: (id: string) => (id === 'account-a' ? clientA : id === 'account-b' ? clientB : undefined) as never,
        getAllConnectedClients: () => new Map<string, IJMAPClient>([['account-a', clientA], ['account-b', clientB]]),
      } as never);
      useEmailStore.setState({
        isUnifiedView: true,
        unifiedRole: 'inbox',
        selectedMailbox: UNIFIED_INBOX,
        emails: [
          makeEmail('a1', { sourceAccountId: 'jmap-a', sourceClientAccountId: 'account-a', mailboxIds: { 'a-inbox': true } }),
          makeEmail('b1', { sourceAccountId: 'jmap-b', sourceClientAccountId: 'account-b', mailboxIds: { 'b-inbox': true } }),
        ],
        totalEmails: 5,
      });
      useEmailStore.getState().selectAllMatching();

      await useEmailStore.getState().batchMarkAsRead(clientA, true);

      expect(clientA.queryAllEmailIds).toHaveBeenCalledWith({ inMailbox: 'a-inbox' }, undefined);
      expect(clientB.queryAllEmailIds).toHaveBeenCalledWith({ inMailbox: 'b-inbox' }, undefined);
      expect(clientA.batchMarkAsRead).toHaveBeenCalledWith(['a1', 'a2', 'a3'], true, 'jmap-a');
      expect(clientB.batchMarkAsRead).toHaveBeenCalledWith(['b1', 'b2'], true, 'jmap-b');
    });
  });
});
