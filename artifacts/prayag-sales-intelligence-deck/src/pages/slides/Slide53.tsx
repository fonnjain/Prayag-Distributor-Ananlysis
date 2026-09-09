import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide53() {
  return (
    <Frame number={53} section="Product Tour">
      <SectionTitle eyebrow="CUSTOMERS" title="Customers: Schemes" subtitle="Trade promotion effectiveness." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Track scheme enrollment</Bullet>
          <Bullet>Measure ROI of promotions</Bullet>
          <Bullet>Identify qualification gaps</Bullet>
          <Bullet>Payout and liability forecasting</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[2vh]">
           <div className="flex justify-between items-center border-b border-[#a9b7c2]/20 pb-[1vh]">
             <div className="text-[1.5vw] text-[#f5f2ea]">Q3 Volume Bonanza</div>
             <div className="text-[1.5vw] text-[#4ccfa3] px-[.8vw] py-[.4vw] bg-[#4ccfa3]/10 border border-[#4ccfa3]/30 rounded-full">Active</div>
           </div>
           <div className="flex gap-[2vw]">
             <div className="flex-1 flex flex-col gap-[1vh]">
               <div className="text-[1.5vw] text-[#a9b7c2]">Enrollment</div>
               <div className="text-[2vw] text-[#1389e8]">XX%</div>
             </div>
             <div className="flex-1 flex flex-col gap-[1vh]">
               <div className="text-[1.5vw] text-[#a9b7c2]">Liability</div>
               <div className="text-[2vw] text-[#f3b44b]">₹ X.X Cr</div>
             </div>
           </div>
        </div>
      </div>
    </Frame>
  );
}
