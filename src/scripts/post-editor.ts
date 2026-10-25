import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { slugify } from '../lib/slug';
import {
  equivalentMarkdown,
  repairEditorIndentation,
  sourceRequiresMarkdown,
} from '../lib/editor-markdown';
import {
  adminRequest,
  AdminRequestError,
  showFormError,
  formData,
} from './admin';

export function setupEditor(form: HTMLFormElement) {
  const input = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement;
  const body = input('body') as unknown as HTMLTextAreaElement;
  const status = document.querySelector<HTMLElement>('#save-status')!;
  const errorBox = document.querySelector<HTMLElement>('#editor-error')!;
  const download =
    document.querySelector<HTMLButtonElement>('#download-draft')!;
  const visualElement = document.querySelector<HTMLElement>('#visual-editor')!;
  const sourceLabel = document.querySelector<HTMLElement>('#source-label')!;
  const sourceWarning = document.querySelector<HTMLElement>('#source-warning')!;
  const visualButton =
    document.querySelector<HTMLButtonElement>('#mode-visual')!;
  const sourceButton =
    document.querySelector<HTMLButtonElement>('#mode-source')!;
  let mode: 'visual' | 'source' = 'source';
  let editor: Editor | undefined;
  let dirty = false,
    serial = 0,
    conflict = false;
  let timer: ReturnType<typeof setTimeout>;
  let queue = Promise.resolve();
  let slugEdited = Boolean(input('slug').value);
  let selectedRevision = 0;
  let operation = false;
  const sourceHistory = [body.value];
  let sourceHistoryIndex = 0,
    traversingHistory = false;
  const isTrash = form.dataset.status === 'trash';
  const count = () => {
    document.querySelector('#word-count')!.textContent =
      (body.value.trim().match(/\S+/g)?.length || 0) + ' words';
  };
  const fail = (error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Unable to save. Please retry.';
    errorBox.hidden = false;
    errorBox.textContent = message;
    status.textContent = 'Changes not saved';
    download.hidden = false;
    if (error instanceof AdminRequestError && error.status === 409)
      conflict = true;
    showFormError(form, error);
  };
  const changed = () => {
    if (
      !traversingHistory &&
      sourceHistory[sourceHistoryIndex] !== body.value
    ) {
      sourceHistory.splice(sourceHistoryIndex + 1);
      sourceHistory.push(body.value);
      if (sourceHistory.length > 200) sourceHistory.shift();
      sourceHistoryIndex = sourceHistory.length - 1;
    }
    dirty = true;
    serial++;
    count();
    status.textContent = conflict
      ? 'Conflict · your changes are still here'
      : 'Unsaved changes';
    clearTimeout(timer);
    if (!conflict && !isTrash)
      timer = setTimeout(() => {
        void save(false).catch(fail);
      }, 2000);
  };
  const setMode = (next: 'visual' | 'source') => {
    let reason = '';
    if (next === 'visual') {
      if (sourceRequiresMarkdown(body.value))
        reason =
          'This draft contains HTML that the visual editor may change. Markdown mode preserves it exactly.';
      else {
        try {
          if (!editor) {
            // The table's default inline width and injected CSS violate our CSP.
            const PlainTable = Table.extend({
              renderHTML() {
                return ['table', {}, ['tbody', 0]];
              },
            });
            editor = new Editor({
              element: visualElement,
              injectCSS: false,
              editable: !isTrash,
              extensions: [
                StarterKit.configure({
                  underline: false,
                  trailingNode: false,
                  dropcursor: false,
                  link: { openOnClick: false },
                }),
                Markdown,
                Image,
                PlainTable.configure({ resizable: false }),
                TableCell,
                TableHeader,
                TableRow,
                TaskList,
                TaskItem.configure({ nested: true }),
              ],
              content: body.value,
              contentType: 'markdown',
              editorProps: {
                attributes: {
                  'aria-label': 'Article body',
                  role: 'textbox',
                  'aria-multiline': 'true',
                },
              },
              onUpdate: () => {
                if (mode === 'visual' && editor) {
                  body.value = editor.getMarkdown();
                  changed();
                }
              },
              onSelectionUpdate: () => updateToolbar(),
            });
          } else
            editor.commands.setContent(body.value, {
              contentType: 'markdown',
              emitUpdate: false,
            });
          if (!equivalentMarkdown(body.value, editor.getMarkdown()))
            reason =
              'This draft uses formatting that cannot be converted reliably. Markdown mode keeps every part of your text intact.';
        } catch {
          reason =
            'The visual editor could not load this draft. You can continue safely in Markdown mode.';
        }
      }
    }
    mode = reason ? 'source' : next;
    sourceWarning.textContent = reason;
    sourceWarning.hidden = !reason;
    sourceLabel.hidden = mode !== 'source';
    visualElement.hidden = mode !== 'visual';
    visualButton.setAttribute('aria-pressed', String(mode === 'visual'));
    sourceButton.setAttribute('aria-pressed', String(mode === 'source'));
    updateToolbar();
  };
  const updateToolbar = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '[data-format]',
    )) {
      const name = (
        {
          bold: 'bold',
          italic: 'italic',
          heading: 'heading',
          list: 'bulletList',
          'numbered-list': 'orderedList',
          quote: 'blockquote',
          code: 'codeBlock',
          table: 'table',
        } as Record<string, string>
      )[button.dataset.format!];
      button.setAttribute(
        'aria-pressed',
        String((mode === 'visual' && name && editor?.isActive(name)) || false),
      );
    }
  };
  const setBody = (text: string) => {
    body.value = text;
    if (mode === 'visual') setMode('visual');
    changed();
  };
  const stepSourceHistory = (direction: number) => {
    const next = sourceHistoryIndex + direction;
    if (next < 0 || next >= sourceHistory.length) return;
    sourceHistoryIndex = next;
    traversingHistory = true;
    setBody(sourceHistory[next]);
    traversingHistory = false;
    body.focus();
  };
  function save(manual: boolean) {
    const run = async () => {
      if (conflict)
        throw new AdminRequestError(
          'Resolve the conflict before saving. Download or copy your text, then reload the post.',
          409,
        );
      if (!manual && !dirty && input('id').value) return;
      if (!input('title').value.trim()) {
        status.textContent = 'Add a title to enable autosave';
        if (manual) {
          form.reportValidity();
          throw new Error('Add a title before saving.');
        }
        return;
      }
      if (manual && !form.reportValidity())
        throw new Error('Check the highlighted fields before saving.');
      const sentSerial = serial;
      const data = formData(form);
      data.set('intent', manual ? 'save' : 'autosave');
      status.textContent = 'Saving…';
      const result = await adminRequest('/api/admin/post', data);
      input('id').value = String(result.id);
      input('version').value = String(result.version);
      if (result.creation_replayed) return run();
      const url = new URL(location.href);
      url.searchParams.set('id', String(result.id));
      url.searchParams.delete('saved');
      history.replaceState(null, '', url);
      dirty = sentSerial !== serial;
      status.textContent = dirty
        ? 'Unsaved changes'
        : 'Saved at ' +
          new Date(result.updated_at).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
      document.querySelector('#post-status')!.textContent = result.label;
      errorBox.hidden = true;
      download.hidden = !dirty;
      form.querySelector('[data-form-result]')?.remove();
      form.querySelectorAll('[data-field-error]').forEach((el) => el.remove());
      form
        .querySelectorAll('[aria-invalid]')
        .forEach((el) => el.removeAttribute('aria-invalid'));
      if (dirty) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void save(false).catch(fail);
        }, 2000);
      }
    };
    queue = queue.catch(() => {}).then(run);
    return queue;
  }
  const flush = async () => {
    clearTimeout(timer);
    await save(true);
    while (dirty) await save(true);
  };
  form.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.name || ['id', 'version', 'csrf'].includes(target.name)) return;
    if (target.name === 'slug') slugEdited = true;
    if (target.name === 'title' && !slugEdited)
      input('slug').value = slugify(input('title').value)
        .slice(0, 180)
        .replace(/-+$/, '');
    changed();
  });
  form.addEventListener('change', (event) => {
    if ((event.target as Element).tagName === 'SELECT') changed();
  });
  const tagInput = input('tags');
  const tagList =
    document.querySelector<HTMLDataListElement>('#tag-suggestions')!;
  const knownTags = Array.from(tagList.options).map((option) => option.value);
  tagInput.addEventListener('input', () => {
    const parts = tagInput.value.split(',');
    parts.pop();
    const prefix = parts.length
      ? parts.map((tag) => tag.trim()).join(', ') + ', '
      : '';
    tagList.replaceChildren(
      ...knownTags
        .filter((tag) => !parts.map((part) => part.trim()).includes(tag))
        .map((tag) => {
          const option = document.createElement('option');
          option.value = prefix + tag;
          return option;
        }),
    );
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save(true).catch(fail);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save(true).catch(fail);
    }
    if (
      mode === 'source' &&
      event.target === body &&
      (event.metaKey || event.ctrlKey) &&
      ['z', 'y'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      stepSourceHistory(
        event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : -1,
      );
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });
  download.addEventListener('click', () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            title: input('title').value,
            slug: input('slug').value,
            summary: input('summary').value,
            tags: input('tags').value,
            type: input('type').value,
            image: input('image').value,
            source_url: input('source_url').value,
            body: body.value,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (input('slug').value || 'unsaved-post') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });
  visualButton.addEventListener('click', () => setMode('visual'));
  sourceButton.addEventListener('click', () => setMode('source'));
  const replaceSelection = (value: string) => {
    body.setRangeText(value, body.selectionStart, body.selectionEnd, 'end');
    body.focus();
    changed();
  };
  const imageDialog =
    document.querySelector<HTMLDialogElement>('#image-dialog')!;
  const linkDialog = document.querySelector<HTMLDialogElement>('#link-dialog')!;
  const addImage = (path: string, alt: string) => {
    if (mode === 'visual' && editor)
      editor.chain().focus().setImage({ src: path, alt }).run();
    else
      replaceSelection(
        `\n![${alt.replace(/[\[\]]/g, '')}](${path.replaceAll(')', '%29')})\n`,
      );
  };
  document.addEventListener('admin:image', (event) => {
    const detail = (event as CustomEvent).detail;
    if (detail.target === 'body') addImage(detail.path, detail.alt);
  });
  linkDialog.addEventListener('close', () => {
    if (linkDialog.returnValue !== 'insert') return;
    const url = (document.querySelector('#link-url') as HTMLInputElement).value;
    const text =
      (document.querySelector('#link-text') as HTMLInputElement).value || url;
    if (!/^https?:\/\//i.test(url)) {
      fail(new Error('Use an http(s) link.'));
      return;
    }
    if (mode === 'visual' && editor) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text,
          marks: [{ type: 'link', attrs: { href: url } }],
        })
        .run();
    } else
      replaceSelection(
        `[${text.replace(/[\[\]]/g, '')}](${url.replaceAll(')', '%29')})`,
      );
  });
  imageDialog.addEventListener('close', () => {
    if (imageDialog.returnValue !== 'insert') return;
    const path = (
      document.querySelector('#inline-image-url') as HTMLInputElement
    ).value;
    if (!/^(?:https?:\/\/|\/uploads\/)/i.test(path)) {
      fail(new Error('Choose an uploaded image or use an http(s) image URL.'));
      return;
    }
    addImage(
      path,
      (document.querySelector('#inline-image-alt') as HTMLInputElement).value,
    );
  });
  document
    .querySelectorAll<HTMLButtonElement>('[data-format]')
    .forEach((button) =>
      button.addEventListener('click', () => {
        const action = button.dataset.format;
        if (action === 'link') {
          if (mode === 'visual' && editor?.isActive('link'))
            editor.chain().extendMarkRange('link').run();
          (document.querySelector('#link-text') as HTMLInputElement).value =
            mode === 'visual'
              ? editor?.state.doc.textBetween(
                  editor.state.selection.from,
                  editor.state.selection.to,
                ) || ''
              : body.value.slice(body.selectionStart, body.selectionEnd);
          (document.querySelector('#link-url') as HTMLInputElement).value =
            mode === 'visual'
              ? editor?.getAttributes('link').href || 'https://'
              : 'https://';
          linkDialog.showModal();
          return;
        }
        if (action === 'image') {
          const attrs = mode === 'visual' ? editor?.getAttributes('image') : {};
          (
            document.querySelector('#inline-image-url') as HTMLInputElement
          ).value = attrs?.src || '';
          (
            document.querySelector('#inline-image-alt') as HTMLInputElement
          ).value = attrs?.alt || '';
          imageDialog.showModal();
          return;
        }
        if (mode === 'visual' && editor) {
          const chain = editor.chain().focus();
          if (action === 'bold') chain.toggleBold().run();
          if (action === 'italic') chain.toggleItalic().run();
          if (action === 'heading') chain.toggleHeading({ level: 2 }).run();
          if (action === 'list') chain.toggleBulletList().run();
          if (action === 'numbered-list') chain.toggleOrderedList().run();
          if (action === 'quote') chain.toggleBlockquote().run();
          if (action === 'code') chain.toggleCodeBlock().run();
          if (action === 'table')
            chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          if (action === 'undo') chain.undo().run();
          if (action === 'redo') chain.redo().run();
        } else {
          const selected =
            body.value.slice(body.selectionStart, body.selectionEnd) || 'text';
          const value = (
            {
              bold: `**${selected}**`,
              italic: `_${selected}_`,
              heading: `## ${selected}`,
              list: `- ${selected}`,
              'numbered-list': `1. ${selected}`,
              quote: `> ${selected}`,
              code: '```\n' + selected + '\n```',
              table:
                '\n| Heading | Heading |\n| --- | --- |\n| Cell | Cell |\n',
            } as Record<string, string>
          )[action!];
          if (value) replaceSelection(value);
          else stepSourceHistory(action === 'undo' ? -1 : 1);
        }
        updateToolbar();
      }),
    );
  document
    .querySelectorAll<HTMLButtonElement>('[data-post-intent]')
    .forEach((button) =>
      button.addEventListener('click', async () => {
        if (operation) return;
        const intent = button.dataset.postIntent!;
        const confirmation =
          intent === 'unpublish'
            ? 'Unpublish this post? Readers will no longer be able to see it.'
            : intent === 'trash'
              ? 'Move this post to trash? It will be hidden and remain recoverable.'
              : intent === 'publish'
                ? form.dataset.live === 'true'
                  ? 'Update the live article with your saved changes?'
                  : 'Publish this post now? It will be visible to readers.'
                : '';
        if (confirmation && !window.confirm(confirmation)) return;
        operation = true;
        form.inert = true;
        editor?.setEditable(false);
        try {
          if (intent !== 'restore') await flush();
          const data = new FormData();
          data.set('csrf', input('csrf').value);
          data.set('id', input('id').value);
          data.set('version', input('version').value);
          data.set('intent', intent);
          if (intent === 'schedule') {
            const value = (
              document.querySelector('#scheduled-at') as HTMLInputElement
            ).value;
            if (!value) throw new Error('Choose a future publication date.');
            data.set('scheduled_at', new Date(value).toISOString());
          }
          await adminRequest('/api/admin/post-action', data);
          dirty = false;
          location.reload();
        } catch (error) {
          fail(error);
        } finally {
          operation = false;
          form.inert = false;
          editor?.setEditable(!isTrash);
        }
      }),
    );
  document
    .querySelector<HTMLInputElement>('#pin-toggle')!
    .addEventListener('change', async (event) => {
      const control = event.target as HTMLInputElement;
      try {
        await flush();
        const data = new FormData();
        data.set('csrf', input('csrf').value);
        data.set('id', input('id').value);
        data.set('pinned', control.checked ? '1' : '0');
        control.disabled = true;
        await adminRequest('/api/admin/pin', data);
        status.textContent = control.checked
          ? 'Pinned · appears when public'
          : 'Unpinned';
      } catch (error) {
        control.checked = !control.checked;
        fail(error);
      } finally {
        control.disabled = false;
      }
    });
  const previewDialog =
    document.querySelector<HTMLDialogElement>('#preview-dialog')!;
  const previewButton =
    document.querySelector<HTMLButtonElement>('#preview-button')!;
  previewButton.addEventListener('click', async () => {
    const snapshot = formData(form);
    previewButton.disabled = true;
    try {
      const response = await fetch('/api/admin/preview', {
        method: 'POST',
        body: snapshot,
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? 'Session expired. Sign in again to preview.'
            : 'Preview failed. Please retry.',
        );
      document.querySelector('#preview-title')!.textContent = String(
        snapshot.get('title') || '',
      );
      document.querySelector('#preview-summary')!.textContent = String(
        snapshot.get('summary') || '',
      );
      const image = document.querySelector<HTMLImageElement>('#preview-cover')!;
      image.hidden = !snapshot.get('image');
      if (snapshot.get('image')) image.src = String(snapshot.get('image'));
      document.querySelector('#preview')!.innerHTML = await response.text();
      previewDialog.showModal();
    } catch (error) {
      fail(error);
    } finally {
      previewButton.disabled = false;
    }
  });
  document
    .querySelector('#close-preview')!
    .addEventListener('click', () => previewDialog.close());
  let repairBefore = '',
    repairAfter = '';
  document.querySelector('#preview-repair')!.addEventListener('click', () => {
    repairBefore = body.value;
    const repair = repairEditorIndentation(body.value);
    repairAfter = repair.text;
    document.querySelector('#repair-before')!.textContent = repairBefore;
    document.querySelector('#repair-after')!.textContent = repairAfter;
    (document.querySelector('#repair-comparison') as HTMLElement).hidden =
      !repair.removed;
    document.querySelector('#repair-result')!.textContent = repair.removed
      ? `Found ${repair.removed} old editor whitespace wrapper(s). Review before applying.`
      : 'No old editor whitespace wrapper found. Your text has not changed.';
  });
  document.querySelector('#apply-repair')!.addEventListener('click', () => {
    if (body.value !== repairBefore) {
      document.querySelector('#repair-result')!.textContent =
        'Text changed. Preview the correction again.';
      return;
    }
    setBody(repairAfter);
    (document.querySelector('#undo-repair') as HTMLElement).hidden = false;
  });
  document.querySelector('#undo-repair')!.addEventListener('click', () => {
    if (body.value !== repairAfter) {
      document.querySelector('#repair-result')!.textContent =
        'There are newer edits. Use revision history to restore the earlier text.';
      return;
    }
    setBody(repairBefore);
    (document.querySelector('#undo-repair') as HTMLElement).hidden = true;
  });
  document
    .querySelectorAll<HTMLButtonElement>('[data-revision]')
    .forEach((button) =>
      button.addEventListener('click', async () => {
        try {
          const response = await fetch(
            `/api/admin/revision?id=${input('id').value}&revision=${button.dataset.revision}`,
          );
          if (!response.ok)
            throw new Error(
              'Unable to load this revision. Sign in again or retry.',
            );
          const revision = JSON.parse((await response.json()).snapshot);
          selectedRevision = Number(button.dataset.revision);
          const comparison = (post: any) =>
            JSON.stringify(
              {
                title: post.title,
                slug: post.slug,
                summary: post.summary,
                tags: post.tags,
                type: post.type,
                image: post.image,
                source_url: post.source_url,
              },
              null,
              2,
            ) +
            '\n\n' +
            post.body;
          document.querySelector('#revision-current')!.textContent = comparison(
            { ...Object.fromEntries(new FormData(form)), body: body.value },
          );
          document.querySelector('#revision-selected')!.textContent =
            comparison(revision);
          (
            document.querySelector('#revision-comparison') as HTMLElement
          ).hidden = false;
        } catch (error) {
          document.querySelector('#revision-result')!.textContent = (
            error as Error
          ).message;
        }
      }),
    );
  document
    .querySelector('#restore-revision')!
    .addEventListener('click', async () => {
      if (
        operation ||
        !selectedRevision ||
        !window.confirm(
          'Restore this revision as a private draft? The live article will stay unchanged.',
        )
      )
        return;
      operation = true;
      form.inert = true;
      editor?.setEditable(false);
      try {
        await flush();
        const data = new FormData();
        data.set('csrf', input('csrf').value);
        data.set('id', input('id').value);
        data.set('version', input('version').value);
        data.set('revision', String(selectedRevision));
        await adminRequest('/api/admin/revision', data);
        dirty = false;
        location.reload();
      } catch (error) {
        fail(error);
      } finally {
        operation = false;
        form.inert = false;
        editor?.setEditable(!isTrash);
      }
    });
  const scheduled = document.querySelector<HTMLInputElement>('#scheduled-at');
  if (scheduled && form.dataset.publishedAt) {
    const date = new Date(form.dataset.publishedAt);
    scheduled.value = new Date(
      date.getTime() - date.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 16);
  }
  count();
  setMode('visual');
}
