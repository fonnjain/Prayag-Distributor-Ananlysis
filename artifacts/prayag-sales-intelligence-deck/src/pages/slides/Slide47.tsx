import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide47() {
  return (
    <Frame number={47} section="Product Tour">
      <SectionTitle eyebrow="COMMERCIAL" title="Commercial: Margin Analysis" subtitle="Gross profit contribution tracking." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Profitability by SKU and Category</Bullet>
          <Bullet>Trade scheme margin impact</Bullet>
          <Bullet>Freight and discount deduction</Bullet>
          <Bullet>Net realization vs budget</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col justify-center">
           <div className="flex justify-between items-center mb-[2vh]">
             <div className="text-[1.5vw] text-[#a9b7c2]">Gross Margin %</div>
             <div className="text-[2vw] text-[#4ccfa3] font-display">XX.X%</div>
           </div>
           <div className="w-full h-[4vh] rounded-full flex overflow-hidden">
             <div className="h-full bg-[#1389e8] w-[45%]" />
             <div className="h-full bg-[#f3b44b] w-[20%]" />
             <div className="h-full bg-[#ff6e66] w-[10%]" />
             <div className="h-full bg-[#4ccfa3] w-[25%]" />
           </div>
           <div className="flex justify-between mt-[2vh] text-[1.5vw] text-[#a9b7c2]">
             <div className="flex items-center gap-[.5vw]"><div className="w-[1vw] h-[1vw] bg-[#1389e8] rounded-full"/> COGS</div>
             <div className="flex items-center gap-[.5vw]"><div className="w-[1vw] h-[1vw] bg-[#f3b44b] rounded-full"/> Freight</div>
             <div className="flex items-center gap-[.5vw]"><div className="w-[1vw] h-[1vw] bg-[#ff6e66] rounded-full"/> Promo</div>
             <div className="flex items-center gap-[.5vw]"><div className="w-[1vw] h-[1vw] bg-[#4ccfa3] rounded-full"/> Margin</div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
