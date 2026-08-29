import { Bullet, Frame, Pill, Rule, SectionTitle } from '../../DeckShared';

export default function Slide2() {
  return (
    <Frame number={2} section="01 / THE OPERATING PICTURE">
      <SectionTitle eyebrow="01 / THE OPERATING PICTURE" title="One operating picture for field sales" />
      <div className="absolute left-[7vw] top-[43vh] w-[34vw]">
        <Rule className="w-[12vw]" />
        <div className="mt-[2.8vh] space-y-[2.2vh]">
          <Bullet>Bring sales, orders, targets, customers, and product data into one workspace</Bullet>
          <Bullet>Move from national overview to state head, member, distributor, retailer, or SKU</Bullet>
          <Bullet>Replace disconnected checks with a repeatable decision flow</Bullet>
        </div>
      </div>
      <div className="absolute right-[7vw] top-[34vh] w-[42vw]">
        <div className="panel p-[2vw]">
          <div className="flex items-center justify-between">
            <span className="thin-label">One workspace / many lenses</span>
            <Pill>CONNECTED</Pill>
          </div>
          <div className="mt-[3vh] grid grid-cols-2 gap-[1vw]">
            <div className="panel-soft p-[1.35vw]"><div className="text-[1.5vw] text-[#7ca5bd]">01</div><div className="mt-[1.4vh] font-display text-[1.7vw] font-semibold">Overview</div><div className="mt-[1vh] small-copy">The headline picture.</div></div>
            <div className="panel-soft p-[1.35vw]"><div className="text-[1.5vw] text-[#7ca5bd]">02</div><div className="mt-[1.4vh] font-display text-[1.7vw] font-semibold">Ownership</div><div className="mt-[1vh] small-copy">The people behind the number.</div></div>
            <div className="panel-soft p-[1.35vw]"><div className="text-[1.5vw] text-[#7ca5bd]">03</div><div className="mt-[1.4vh] font-display text-[1.7vw] font-semibold">Opportunity</div><div className="mt-[1vh] small-copy">The account or SKU to move.</div></div>
            <div className="panel-soft p-[1.35vw]"><div className="text-[1.5vw] text-[#7ca5bd]">04</div><div className="mt-[1.4vh] font-display text-[1.7vw] font-semibold">Action</div><div className="mt-[1vh] small-copy">The next reviewable step.</div></div>
          </div>
        </div>
      </div>
    </Frame>
  );
}