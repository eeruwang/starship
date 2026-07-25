/**
 * Same-author grouping observer.
 * Watches column-content children and toggles .post-grouped on consecutive
 * cards from the same author. Boosts/renotes are excluded by renderPost
 * not setting data-author-acct on them.
 */

function authorOf(card) {
  if (!card || !card.classList || !card.classList.contains('post-card')) return null;
  if (card.classList.contains('merged-border')) return null;
  return card.dataset.authorAcct || null;
}

// 그룹핑 가능 여부: 작성자 일치 + (답글이라면 같은 대상에 단 답글이어야 함).
// 한쪽만 답글이거나 답글 대상이 서로 다르면 묶지 않는다.
function canGroup(card, prev) {
  const mine = authorOf(card);
  const prevAcct = authorOf(prev);
  if (!mine || !prevAcct || mine !== prevAcct) return false;
  const myReply = card.dataset.replyToId || '';
  const prevReply = prev.dataset.replyToId || '';
  if (myReply !== prevReply) return false;
  return true;
}

function updateOne(card) {
  // 사용자 피드백: 같은 작성자 연속 글이 답글/댓글처럼 들여쓰기+레일로 보여 혼란.
  // "이렇게 들어가는 거 없애줘. 댓글도 아닌데 연속으로 나왔다고 저렇게 댓글처럼 떠"
  // → 그룹핑 클래스를 부여하지 않고 남아있으면 제거만 한다.
  if (!card || !card.classList?.contains('post-card')) return;
  card.classList.remove('post-grouped');
}

function updateBatch(container) {
  if (!container) return;
  container.querySelectorAll(':scope > .post-card').forEach(updateOne);
}

const watchedContainers = new WeakSet();

export function watchColumnGrouping(container) {
  if (!container || watchedContainers.has(container)) return;
  watchedContainers.add(container);
  updateBatch(container);
  const obs = new MutationObserver((mutations) => {
    const needsUpdate = new Set();
    for (const m of mutations) {
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.classList?.contains('post-card')) {
          needsUpdate.add(n);
          if (n.nextElementSibling) needsUpdate.add(n.nextElementSibling);
        }
      });
      m.removedNodes.forEach(() => {
        // sibling stitch-up
        if (m.nextSibling?.nodeType === 1) needsUpdate.add(m.nextSibling);
      });
    }
    needsUpdate.forEach(updateOne);
  });
  obs.observe(container, { childList: true });
}

export function watchAllColumns(root = document) {
  root.querySelectorAll('.column-content').forEach(watchColumnGrouping);
}
