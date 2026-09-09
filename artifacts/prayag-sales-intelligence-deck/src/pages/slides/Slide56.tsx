import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide56() {
  return (
    <Frame number={56} section="Product Tour">
      <SectionTitle eyebrow="ORGANISATION" title="Coverage & Attribution" subtitle="Resolving mapping conflicts." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Detect orphan customers</Bullet>
          <Bullet>Resolve multi-rep territory overlap</Bullet>
          <Bullet>Ensure clean incentive calculation</Bullet>
          <Bullet>Audit trail for territory shifts</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex items-center gap-[3vw]">
          <div className="flex-1 flex flex-col gap-[2vh]">
            <div className="p-[1.5vw] bg-[#ff6e66]/10 border border-[#ff6e66]/30 rounded">
              <div className="text-[1.5vw] text-[#ffaaa3] mb-[.5vh]">Conflict Detected</div>
              <div className="text-[1.5vw] text-[#a9b7c2]">Customer mapped to two ASMs.</div>
            </div>
            <div className="p-[1.5vw] bg-[#f3b44b]/10 border border-[#f3b44b]/30 rounded">
              <div className="text-[1.5vw] text-[#f3b44b] mb-[.5vh]">Orphan Record</div>
              <div className="text-[1.5vw] text-[#a9b7c2]">No sales rep assigned to territory.</div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
