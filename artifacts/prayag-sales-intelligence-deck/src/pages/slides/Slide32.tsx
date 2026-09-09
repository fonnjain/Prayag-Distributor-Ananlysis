import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide32() {
  return (
    <Frame number={32} section="Product Tour">
      <SectionTitle eyebrow="PLANNING" title="Planning: Targets" subtitle="Goal setting and achievement tracking." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Set quotas at all hierarchy levels</Bullet>
          <Bullet>Track achievement vs run-rate</Bullet>
          <Bullet>Visual progress bars</Bullet>
          <Bullet>Historic target attainment analysis</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[3vh] justify-center">
          <div>
            <div className="flex justify-between text-[1.5vw] text-[#a9b7c2] mb-[.5vh]">
              <span>Monthly Target</span>
              <span className="text-[#4ccfa3]">XX%</span>
            </div>
            <div className="w-full h-[2vh] bg-[#08121f] rounded overflow-hidden">
               <div className="h-full w-[85%] bg-[#4ccfa3]" />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-[1.5vw] text-[#a9b7c2] mb-[.5vh]">
              <span>Quarterly Target</span>
              <span className="text-[#1389e8]">XX%</span>
            </div>
            <div className="w-full h-[2vh] bg-[#08121f] rounded overflow-hidden">
               <div className="h-full w-[42%] bg-[#1389e8]" />
            </div>
          </div>
          <div>
            <div className="flex justify-between text-[1.5vw] text-[#a9b7c2] mb-[.5vh]">
              <span>Annual Target</span>
              <span className="text-[#f3b44b]">XX%</span>
            </div>
            <div className="w-full h-[2vh] bg-[#08121f] rounded overflow-hidden">
               <div className="h-full w-[18%] bg-[#f3b44b]" />
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
