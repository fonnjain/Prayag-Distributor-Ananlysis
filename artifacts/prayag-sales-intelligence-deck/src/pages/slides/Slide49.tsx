import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide49() {
  return (
    <Frame number={49} section="Product Tour">
      <SectionTitle eyebrow="MARKET" title="Market: Intelligence Survey" subtitle="Field-captured competitive pricing." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Crowd-sourced pricing from the field</Bullet>
          <Bullet>Competitor scheme tracking</Bullet>
          <Bullet>Photographic evidence capture</Bullet>
          <Bullet>Real-time market feedback loop</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex gap-[2vw]">
          <div className="flex-1 bg-[#08121f]/50 border border-[#a9b7c2]/20 rounded p-[1vw] flex flex-col">
            <div className="h-[12vh] bg-[#a9b7c2]/10 rounded mb-[1vh] flex items-center justify-center text-[#a9b7c2] text-[1.5vw]">Photo</div>
            <div className="h-[1.5vh] w-[80%] bg-[#a9b7c2]/20 rounded mb-[1vh]" />
            <div className="h-[1.5vh] w-[60%] bg-[#f3b44b]/30 rounded" />
          </div>
          <div className="flex-1 bg-[#08121f]/50 border border-[#a9b7c2]/20 rounded p-[1vw] flex flex-col">
            <div className="h-[12vh] bg-[#a9b7c2]/10 rounded mb-[1vh] flex items-center justify-center text-[#a9b7c2] text-[1.5vw]">Photo</div>
            <div className="h-[1.5vh] w-[70%] bg-[#a9b7c2]/20 rounded mb-[1vh]" />
            <div className="h-[1.5vh] w-[50%] bg-[#f3b44b]/30 rounded" />
          </div>
        </div>
      </div>
    </Frame>
  );
}
