import { Bullet, Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide13() {
  return (
    <Frame number={13} section="12 / COMMERCIAL LEVERS">
      <SectionTitle eyebrow="12 / COMMERCIAL LEVERS" title="Bring commercial levers into the review" />
      <div className="absolute left-[7vw] right-[7vw] top-[42vh] grid grid-cols-3 gap-[1.3vw]">
        <div className="panel min-h-[30vh] p-[1.7vw]"><Pill tone="amber">SCHEMES</Pill><div className="mt-[2.7vh] font-display text-[2vw] font-semibold">Progress that can be pushed</div><div className="mt-[2.2vh] space-y-[1.7vh]"><Bullet tone="amber">Schemes connect eligibility, tiers, progress, and push lists</Bullet></div><div className="mt-[3vh] h-[.14vw] w-[10vw] bg-[#f3b44b]" /></div>
        <div className="panel min-h-[30vh] p-[1.7vw]"><Pill tone="green">PRICE & MARGIN</Pill><div className="mt-[2.7vh] font-display text-[2vw] font-semibold">Value behind the sale</div><div className="mt-[2.2vh] space-y-[1.7vh]"><Bullet tone="green">MRP Master and Margin make price and profitability visible</Bullet></div><div className="mt-[3vh] h-[.14vw] w-[10vw] bg-[#4ccfa3]" /></div>
        <div className="panel min-h-[30vh] p-[1.7vw]"><Pill>MARKET</Pill><div className="mt-[2.7vh] font-display text-[2vw] font-semibold">Context around the account</div><div className="mt-[2.2vh] space-y-[1.7vh]"><Bullet>Competition and Market Survey add external context</Bullet><Bullet>Commercial decisions stay linked to customer and product evidence</Bullet></div><div className="mt-[3vh] h-[.14vw] w-[10vw] bg-[#1389e8]" /></div>
      </div>
    </Frame>
  );
}