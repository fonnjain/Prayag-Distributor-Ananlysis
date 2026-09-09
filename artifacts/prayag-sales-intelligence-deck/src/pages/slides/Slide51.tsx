import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide51() {
  return (
    <Frame number={51} section="Product Tour">
      <SectionTitle eyebrow="CUSTOMERS" title="Customers: Price Shrinkers" subtitle="Accounts with declining realisation." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Detect margin erosion automatically</Bullet>
          <Bullet>Identify over-discounting</Bullet>
          <Bullet>Flag scheme abuse</Bullet>
          <Bullet>Protect overall profitability</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col justify-center">
          <div className="flex items-center gap-[2vw]">
            <div className="w-[10vw] h-[10vw] rounded-full border-[1vw] border-[#ff6e66]/20 flex items-center justify-center">
              <div className="text-[2vw] text-[#ff6e66] font-display">-XX%</div>
            </div>
            <div className="flex-1">
              <div className="text-[1.5vw] text-[#f5f2ea] mb-[1vh]">Realisation Drop Alert</div>
              <p className="text-[2vw] text-[#a9b7c2]">XX customers have seen a &gt;XX% drop in net realisation over the past 30 days despite steady volume.</p>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
