'use strict';

function normalizeEpisodeCount(episodeCount, vidListLength = 0) {
  const pageCount = Math.trunc(Number(episodeCount));
  if (Number.isFinite(pageCount) && pageCount > 0) return pageCount;

  const listCount = Math.trunc(Number(vidListLength));
  return Number.isFinite(listCount) && listCount > 0 ? listCount : 0;
}

function appGrabRange(total) {
  const normalized = normalizeEpisodeCount(total);
  return normalized > 0 ? {startEp: 1, endEp: normalized} : null;
}

function isCompleteMarker(content) {
  const match = String(content || '').trim().match(/^(\d+)\/(\d+)$/);
  if (!match) return false;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && completed === total;
}

module.exports = {
  appGrabRange,
  isCompleteMarker,
  normalizeEpisodeCount,
};
