import { getActiveMapPack } from '@richman/board-data';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { getCellPresentationModel } from '../ui/boardLayout';
import BoardCell from './BoardCell.vue';

const chinaMap = getActiveMapPack('china-tour');
const propertyCell = (() => {
  const cell = chinaMap.game.board.cells.find(
    (candidate) => candidate.type === 'property' && candidate.subtype === 'normal',
  );
  if (cell === undefined) throw new Error('Expected a normal property');
  return cell;
})();

async function renderOwnerStrip(mortgaged: boolean): Promise<string> {
  const app = createSSRApp({
    render: () => h(BoardCell, {
      cell: propertyCell,
      presentation: getCellPresentationModel(chinaMap, propertyCell.id),
      property: { ownerId: 'blue-player', level: 0, mortgaged },
      ownerColorKey: 'blue',
    }),
  });

  return renderToString(app);
}

function ownerStripClasses(html: string): string[] {
  const match = html.match(/class="([^"]*\bowner-strip\b[^"]*)"/);
  if (match === null) throw new Error('Expected owner strip');
  return match[1].split(' ');
}

describe('BoardCell owner strip', () => {
  it('marks a mortgaged property strip as mortgaged', async () => {
    expect(ownerStripClasses(await renderOwnerStrip(true))).toEqual(
      expect.arrayContaining(['owner-strip', 'owner-blue', 'mortgaged']),
    );
  });

  it('keeps a redeemed property strip in its owner color', async () => {
    const classes = ownerStripClasses(await renderOwnerStrip(false));
    expect(classes).toEqual(expect.arrayContaining(['owner-strip', 'owner-blue']));
    expect(classes).not.toContain('mortgaged');
  });
});
